import { basename } from "node:path";
import type { FluxAssetProgress } from "./types";

export function emitPythonInstallLog(
  options: { onProgress?: (progress: FluxAssetProgress) => void },
  line: string,
): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const progress = parsePipDownloadProgressLine(trimmed);
  options.onProgress?.({
    progressText: "Flux Python 런타임 설치 중",
    detail: progress?.detail ?? trimmed.slice(0, 180),
    progressMode: progress ? "determinate" : "indeterminate",
    progressPercent: progress?.progressPercent,
    progressBytes: progress?.progressBytes,
    progressTotalBytes: progress?.progressTotalBytes,
    installLogLine: trimmed,
  });
}

export function parsePipDownloadProgressLine(
  line: string,
): Pick<
  FluxAssetProgress,
  "detail" | "progressPercent" | "progressBytes" | "progressTotalBytes"
> | null {
  const text = line.trim();
  const fileStartMatch = text.match(
    /^(Downloading|Using cached)\s+(.+?)\s+\(([\d.]+)\s*([KMGT]?B)\)$/i,
  );
  if (fileStartMatch) {
    const [, action, fileName, totalValue, totalUnit] = fileStartMatch;
    const totalBytes = parsePipByteValue(totalValue, totalUnit);
    if (totalBytes > 0) {
      const isCached = action.toLowerCase() === "using cached";
      return {
        detail: `${basename(fileName)} · ${isCached ? "캐시 사용" : `0 B / ${formatBytes(totalBytes)}`}`,
        progressPercent: isCached ? 1 : 0,
        progressBytes: isCached ? totalBytes : 0,
        progressTotalBytes: totalBytes,
      };
    }
  }

  const progressMatch = text.match(/([\d.]+)\s*\/\s*([\d.]+)\s*([KMGT]?B)\b/i);
  if (!progressMatch) {
    return null;
  }
  const [, currentValue, totalValue, unit] = progressMatch;
  const progressBytes = parsePipByteValue(currentValue, unit);
  const progressTotalBytes = parsePipByteValue(totalValue, unit);
  if (progressBytes < 0 || progressTotalBytes <= 0) {
    return null;
  }
  return {
    detail: `${formatBytes(progressBytes)} / ${formatBytes(progressTotalBytes)}`,
    progressPercent: Math.max(
      0,
      Math.min(1, progressBytes / progressTotalBytes),
    ),
    progressBytes,
    progressTotalBytes,
  };
}

function parsePipByteValue(valueText: string, unitText: string): number {
  const value = Number(valueText);
  if (!Number.isFinite(value) || value < 0) {
    return -1;
  }
  const normalizedUnit = unitText.trim().toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  };
  return Math.round(value * (multipliers[normalizedUnit] ?? 1));
}

export function emitDownloadProgress(
  options: {
    progressText: string;
    label: string;
    onProgress?: (progress: FluxAssetProgress) => void;
  },
  receivedBytes: number,
  totalBytes: number,
  done = false,
): void {
  options.onProgress?.({
    progressText: done
      ? `${options.label} 다운로드 완료`
      : options.progressText,
    detail:
      totalBytes > 0
        ? `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`
        : `${formatBytes(receivedBytes)} 받음`,
    progressMode: totalBytes > 0 ? "determinate" : "log-only",
    progressPercent:
      totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : undefined,
    progressBytes: totalBytes > 0 ? receivedBytes : undefined,
    progressTotalBytes: totalBytes > 0 ? totalBytes : undefined,
    installLogLine:
      totalBytes > 0
        ? `${options.label}: ${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`
        : `${options.label}: ${formatBytes(receivedBytes)}`,
  });
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
