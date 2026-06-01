const { existsSync, readFileSync } = require("node:fs");

const {
  DEFAULT_OCR_BBOX_PAGE_TIMEOUT_MS,
  DEFAULT_OCR_BBOX_TIMEOUT_MS
} = require("./simple-page-defaults.cjs");
const { readPositiveInteger } = require("./simple-page-prompts.cjs");

function truncateText(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

function clampProgressRatio(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return Math.max(0, Math.min(1, Number(fallback) || 0));
  }
  return Math.max(0, Math.min(1, number));
}

function parsePipRawProgress(line) {
  const text = String(line ?? "");
  const progressMatch = text.match(/\bProgress\s+(\d+)\s+of\s+(\d+)\b/i);
  if (progressMatch) {
    const current = Number(progressMatch[1]);
    const total = Number(progressMatch[2]);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
      return { current: Math.max(0, Math.min(current, total)), total };
    }
  }
  return null;
}

function parseOcrBatchProgressLine(line) {
  const text = String(line ?? "").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return null;
  }
  try {
    const payload = JSON.parse(text);
    const index = Number(payload?.index);
    const total = Number(payload?.total);
    if (!Number.isFinite(index) || !Number.isFinite(total) || index <= 0 || total <= 0) {
      return null;
    }
    const rawPhase = String(payload?.phase ?? "done").trim().toLowerCase();
    const phase = rawPhase === "start" ? "start" : "done";
    return {
      phase,
      index: Math.max(1, Math.min(Math.floor(index), Math.floor(total))),
      total: Math.floor(total),
      count: Number.isFinite(Number(payload?.count)) ? Math.max(0, Math.floor(Number(payload.count))) : 0
    };
  } catch {
    return null;
  }
}

function parsePaddleModelFetchProgress(line) {
  const text = String(line ?? "");
  const fetchMatch = text.match(/\bFetching\s+(\d+)\s+files:\s+(\d+)%/i);
  if (!fetchMatch) {
    return null;
  }

  const totalFiles = Number(fetchMatch[1]);
  const percent = Number(fetchMatch[2]);
  const fractionMatch = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  const currentFiles = fractionMatch && Number(fractionMatch[2]) === totalFiles ? Number(fractionMatch[1]) : null;

  return {
    totalFiles,
    currentFiles: Number.isFinite(currentFiles) ? Math.max(0, Math.min(currentFiles, totalFiles)) : null,
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(percent, 100)) : null
  };
}

function formatPaddleModelFetchProgress(progress) {
  const countText = Number.isFinite(progress.currentFiles)
    ? `${progress.currentFiles} / ${progress.totalFiles}개`
    : `${progress.totalFiles}개`;
  const percentText = Number.isFinite(progress.percent) ? ` (${progress.percent}%)` : "";
  return `Paddle OCR 모델 파일 다운로드 중: ${countText}${percentText}`;
}

function resolveOcrBboxTimeoutMs(pageCount = 1) {
  const explicit = readPositiveInteger(process.env.MANGA_TRANSLATOR_OCR_BBOX_TIMEOUT_MS);
  if (explicit) {
    return explicit;
  }
  const pages = Math.max(1, readPositiveInteger(pageCount) || 1);
  return Math.max(DEFAULT_OCR_BBOX_TIMEOUT_MS, pages * DEFAULT_OCR_BBOX_PAGE_TIMEOUT_MS);
}

function createOcrBatchProgressFilePoller(progressPath, onLine) {
  let timer = null;
  let consumedLines = 0;
  const readProgressFile = () => {
    if (!progressPath || !existsSync(progressPath)) {
      return;
    }
    let raw = "";
    try {
      raw = readFileSync(progressPath, "utf8");
    } catch {
      return;
    }
    if (!raw) {
      return;
    }
    const completeText = raw.endsWith("\n") || raw.endsWith("\r") ? raw : raw.replace(/[^\r\n]*$/, "");
    if (!completeText) {
      return;
    }
    const lines = completeText.split(/\r?\n/).filter(Boolean);
    for (let index = consumedLines; index < lines.length; index += 1) {
      onLine(lines[index]);
    }
    consumedLines = lines.length;
  };

  return {
    start() {
      readProgressFile();
      timer = setInterval(readProgressFile, 500);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      readProgressFile();
    }
  };
}

function sanitizeInstallLogLine(line) {
  const text = String(line ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateText(text, 220);
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

module.exports = {
  clampProgressRatio,
  createOcrBatchProgressFilePoller,
  formatBytes,
  formatPaddleModelFetchProgress,
  parseOcrBatchProgressLine,
  parsePaddleModelFetchProgress,
  parsePipRawProgress,
  resolveOcrBboxTimeoutMs,
  sanitizeInstallLogLine
};
