import { basename } from "node:path";
import type { FluxAssetProgress } from "./types";
import { tMain } from "../localization";

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
    progressText: tMain("inpainting.runtime.pythonInstalling"),
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
        detail: isCached
          ? tMain("downloads.cachedDetail", { file: basename(fileName) })
          : `${basename(fileName)} · 0 B / ${formatBytes(totalBytes)}`,
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

/**
 * Aggregates progress from several files downloaded concurrently into a single
 * combined byte/percent stream. Without this, two parallel downloads sharing one
 * `onProgress` callback make the displayed percentage flip-flop between files.
 * Call `forFile()` once per parallel download and pass the returned callback as
 * that download's `onProgress`.
 */
export function createCombinedDownloadProgress(
  onProgress: ((progress: FluxAssetProgress) => void) | undefined,
  label: string,
): { forFile: () => (progress: FluxAssetProgress) => void } {
  const slots: Array<{ received: number; total: number }> = [];
  const forFile = () => {
    const slot = { received: 0, total: 0 };
    slots.push(slot);
    return (progress: FluxAssetProgress) => {
      if (
        Number.isFinite(progress.progressBytes) &&
        Number.isFinite(progress.progressTotalBytes)
      ) {
        slot.received = Number(progress.progressBytes);
        slot.total = Number(progress.progressTotalBytes);
      }
      const received = slots.reduce((sum, file) => sum + file.received, 0);
      const total = slots.reduce((sum, file) => sum + file.total, 0);
      onProgress?.({
        progressText: tMain("downloads.downloading", { label }),
        detail:
          total > 0
            ? `${formatBytes(received)} / ${formatBytes(total)}`
            : progress.detail,
        progressMode:
          total > 0
            ? "determinate"
            : (progress.progressMode ?? "indeterminate"),
        progressPercent: total > 0 ? Math.min(1, received / total) : undefined,
        progressBytes: total > 0 ? received : undefined,
        progressTotalBytes: total > 0 ? total : undefined,
        installLogLine: progress.installLogLine,
      });
    };
  };
  return { forFile };
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
