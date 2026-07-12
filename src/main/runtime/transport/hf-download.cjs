// @ts-check
/** @typedef {import("../runtime-jsdoc-types").DetailedError} DetailedError */
/** @typedef {{ url: string; file: string; destination: string; label: string; progressPhase?: string; progressTitle?: string; completeTitle?: string; [key: string]: unknown }} HfDownloadTask */
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { abortSignal?: AbortSignal | null; [key: string]: unknown }} DownloadOptions */
/** @typedef {{ knownAggregateBytes?: number; totalBytes?: number; completedBytes?: number; onComplete?: (receivedBytes: number) => void }} DownloadProgress */
const { mkdir, rename, rm } = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const {
  createDetailedError,
  emitRuntimeProgress,
  safeCleanup,
} = require("../simple-page-runtime-common.cjs");
const {
  isAbortError,
  resolveDownloadRetryCount,
} = require("./download-primitives.cjs");
const {
  emitDownloadRetryProgress,
  emitHfDownloadProgress,
  resolveDownloadProgressTitle,
} = require("./download-progress.cjs");
const { downloadHfFileByRanges } = require("./download-ranges.cjs");
const { downloadHfFileByStream } = require("./download-stream.cjs");

/** @param {HfDownloadTask} task @param {DownloadOptions} [options] @param {DownloadProgress} [progress] */
async function downloadHfFileWithProgress(task, options = {}, progress = {}) {
  const maxAttempts = resolveDownloadRetryCount();
  const fallbackState = { used: false };
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await downloadAttempt(
        task,
        options,
        progress,
        attempt,
        maxAttempts,
        fallbackState,
      );
      return;
    } catch (error) {
      if (options.abortSignal?.aborted || isAbortError(error)) throw error;
      lastError = error;
      if (hasFallbackFailed(error) || attempt >= maxAttempts) break;
      emitDownloadRetryProgress(options, task, error, attempt + 1, maxAttempts);
      await retryDelay(attempt, options.abortSignal);
    }
  }
  throw (
    lastError ||
    createDetailedError(`${task.label} 다운로드에 실패했습니다.`, {
      url: task.url,
      file: task.file,
    })
  );
}

/** @param {unknown} error */
function hasFallbackFailed(error) {
  return (
    error instanceof Error &&
    /** @type {DetailedError} */ (error).rangeFallbackFailed === true
  );
}

/** @param {number} attempt @param {AbortSignal | null | undefined} signal */
function retryDelay(attempt, signal) {
  return delay(Math.min(30000, 1000 * 2 ** (attempt - 1)), undefined, {
    signal: signal ?? undefined,
  });
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {number} attempt @param {number} maxAttempts @param {{ used: boolean }} fallbackState */
async function downloadAttempt(
  task,
  options,
  progress,
  attempt,
  maxAttempts,
  fallbackState,
) {
  const partPath = `${task.destination}.part`;
  await mkdir(path.dirname(task.destination), { recursive: true });
  await rm(partPath, { force: true });
  emitDownloadStart(task, options, progress, attempt, maxAttempts);
  const startedAt = Date.now();
  try {
    const receivedBytes = await transferFile(
      task,
      options,
      progress,
      partPath,
      startedAt,
      fallbackState,
    );
    await commitDownload(task.destination, partPath);
    completeDownload(task, options, progress, receivedBytes, startedAt);
  } catch (error) {
    await safeCleanup("remove partial HF download", () =>
      rm(partPath, { force: true }),
    );
    throw error;
  }
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {number} attempt @param {number} maxAttempts */
function emitDownloadStart(task, options, progress, attempt, maxAttempts) {
  const state = initialProgressState(progress);
  emitRuntimeProgress(
    options,
    task.progressPhase || "model_downloading",
    resolveDownloadProgressTitle(task, false),
    `${task.label}: ${task.file}`,
    {
      ...state,
      installLogLine: initialDownloadLogLine(task, attempt, maxAttempts),
    },
  );
}

/** @param {DownloadProgress} progress */
function initialProgressState(progress) {
  const aggregate = progress.knownAggregateBytes || 0;
  const total = progress.totalBytes || 0;
  if (aggregate) {
    return {
      progressMode: "determinate",
      progressPercent: (progress.completedBytes || 0) / aggregate,
      progressBytes: progress.completedBytes || 0,
      progressTotalBytes: aggregate,
    };
  }
  return {
    progressMode: total ? "determinate" : "log-only",
    progressPercent: total ? 0 : undefined,
    progressBytes: total ? 0 : undefined,
    progressTotalBytes: total || undefined,
  };
}

/** @param {HfDownloadTask} task @param {number} attempt @param {number} maxAttempts */
function initialDownloadLogLine(task, attempt, maxAttempts) {
  return attempt > 1
    ? `${task.label} 다운로드 재시도 ${attempt}/${maxAttempts}: ${task.file}`
    : `${task.label} 다운로드 시작: ${task.file}`;
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {string} partPath @param {number} startedAt @param {{ used: boolean }} fallbackState */
function transferFile(
  task,
  options,
  progress,
  partPath,
  startedAt,
  fallbackState,
) {
  const totalBytes = progress.totalBytes || 0;
  return totalBytes > 0
    ? downloadHfFileByRanges(
        task,
        options,
        progress,
        partPath,
        totalBytes,
        startedAt,
        fallbackState,
      )
    : downloadHfFileByStream(task, options, progress, partPath, startedAt);
}

/** @param {string} destination @param {string} partPath */
async function commitDownload(destination, partPath) {
  await rm(destination, { force: true });
  await rename(partPath, destination);
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {number} receivedBytes @param {number} startedAt */
function completeDownload(task, options, progress, receivedBytes, startedAt) {
  progress.onComplete?.(receivedBytes);
  emitHfDownloadProgress(options, task, {
    receivedBytes,
    totalBytes: progress.totalBytes || 0,
    knownAggregateBytes: progress.knownAggregateBytes || 0,
    aggregateCompletedBytes: progress.completedBytes || 0,
    startedAt,
    completed: true,
  });
}

module.exports = { downloadHfFileWithProgress };
