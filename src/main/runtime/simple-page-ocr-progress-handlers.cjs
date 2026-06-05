const {
  clampProgressRatio,
  formatBytes,
  formatPaddleModelFetchProgress,
  parseOcrBatchProgressLine,
  parsePaddleModelFetchProgress,
  parsePipRawProgress,
  sanitizeInstallLogLine
} = require("./simple-page-progress.cjs");

function emitRuntimeProgress(options = {}, phase, progressText, detail, progress = {}) {
  if (typeof options.onProgress !== "function") {
    return;
  }
  try {
    options.onProgress({ phase, progressText, detail, ...progress });
  } catch {
    // Progress reporting must never interrupt OCR work.
  }
}

function startTaskProgressMonitor(options = {}, config = {}) {
  const phase = config.phase || "ocr_downloading";
  const progressText = config.progressText || "설치 중";
  const detailPrefix = config.detailPrefix || "";
  let stepText = "";
  let stepStart = clampProgressRatio(config.startPercent, 0);
  let stepEnd = clampProgressRatio(config.endPercent, 0.95);
  let lastRatio = stepStart;
  let stopped = false;

  const emit = (extra = {}) => {
    if (stopped) {
      return;
    }
    const detail = [detailPrefix, stepText].filter(Boolean).join(" · ");
    emitRuntimeProgress(options, phase, progressText, detail, {
      progressMode: "log-only",
      ...extra
    });
  };

  emit({ installLogLine: "설치 작업을 시작합니다." });
  return {
    setStep(text, startPercent, endPercent) {
      stepText = text;
      stepStart = Math.max(lastRatio, clampProgressRatio(startPercent, lastRatio));
      stepEnd = Math.max(stepStart, clampProgressRatio(endPercent, stepStart));
      emit({ progressMode: "indeterminate", installLogLine: text });
    },
    completeStep(text = "") {
      lastRatio = Math.max(lastRatio, stepEnd);
      emit({
        progressMode: "determinate",
        progressPercent: lastRatio,
        installLogLine: text || `${stepText} 완료`
      });
    },
    log(line) {
      const logLine = sanitizeInstallLogLine(line);
      if (!logLine) {
        return;
      }
      const pipProgress = parsePipRawProgress(logLine);
      if (pipProgress) {
        emit({
          progressMode: "indeterminate",
          progressBytes: pipProgress.current,
          progressTotalBytes: pipProgress.total,
          installLogLine: `${stepText}: 현재 다운로드 ${formatBytes(pipProgress.current)} / ${formatBytes(pipProgress.total)}`
        });
        return;
      }
      emit({ progressMode: "indeterminate", installLogLine: logLine });
    },
    stop(finalProgress = null) {
      stopped = true;
      if (finalProgress) {
        emitRuntimeProgress(options, phase, progressText, finalProgress.detail, finalProgress);
      }
    }
  };
}

function createOcrCommandProgressHandler(options = {}, config = {}) {
  let lastDetail = "";
  let lastAt = 0;
  return (line) => {
    const logLine = sanitizeInstallLogLine(line);
    if (!logLine || parseOcrBatchProgressLine(logLine)) {
      return;
    }

    const fetchProgress = parsePaddleModelFetchProgress(logLine);
    const isModelStatusLine = Boolean(fetchProgress) ||
      /^(Creating model:|Checking connectivity|Using official model|Fetching \d+ files:)/i.test(logLine);
    if (!isModelStatusLine) {
      return;
    }

    const detail = fetchProgress
      ? formatPaddleModelFetchProgress(fetchProgress)
      : logLine;
    const now = Date.now();
    if (detail === lastDetail && now - lastAt < 2000) {
      return;
    }
    lastDetail = detail;
    lastAt = now;

    emitRuntimeProgress(options, "ocr_running", config.progressText || "Paddle OCR 모델 다운로드/위치 분석 중", detail, {
      progressMode: "log-only",
      progressCurrent: config.progressCurrent,
      progressTotal: config.progressTotal,
      installLogLine: logLine
    });
  };
}

module.exports = {
  createOcrCommandProgressHandler,
  startTaskProgressMonitor
};
