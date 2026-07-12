// @ts-check
/** @typedef {{ url: string; file: string; destination: string; label: string; progressPhase?: string; progressTitle?: string; completeTitle?: string; [key: string]: unknown }} HfDownloadTask */
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { abortSignal?: AbortSignal | null; [key: string]: unknown }} DownloadOptions */
/** @typedef {{ receivedBytes: number; totalBytes?: number; knownAggregateBytes?: number; aggregateCompletedBytes?: number; startedAt: number; completed?: boolean }} HfDownloadProgressState */
const { formatBytes } = require("../simple-page-progress.cjs");
const { emitRuntimeProgress } = require("../simple-page-runtime-common.cjs");

/** @param {DownloadOptions} options @param {HfDownloadTask} task @param {unknown} error @param {number} nextAttempt @param {number} maxAttempts @param {string} [range] */
function emitDownloadRetryProgress(
  options,
  task,
  error,
  nextAttempt,
  maxAttempts,
  range = "",
) {
  const suffix = range ? ` (${range})` : "";
  emitRuntimeProgress(
    options,
    task.progressPhase || "model_downloading",
    resolveDownloadProgressTitle(task, false),
    `${task.label}: ${task.file}`,
    {
      progressMode: "log-only",
      installLogLine: `${task.label} 다운로드 재시도 ${nextAttempt}/${maxAttempts}${suffix}: ${errorMessage(error)}`,
    },
  );
}

/** @param {DownloadOptions} options @param {HfDownloadTask} task @param {unknown} error */
function emitRangeFallbackProgress(options, task, error) {
  emitRuntimeProgress(
    options,
    task.progressPhase || "model_downloading",
    resolveDownloadProgressTitle(task, false),
    `${task.label}: ${task.file}`,
    {
      progressMode: "log-only",
      installLogLine: `${task.label} 범위 다운로드 실패로 일반 다운로드로 전환합니다: ${errorMessage(error)}`,
    },
  );
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {DownloadOptions} options @param {HfDownloadTask} task @param {HfDownloadProgressState} state */
function emitHfDownloadProgress(options, task, state) {
  const metrics = calculateProgressMetrics(state);
  const fileProgress = formatFileProgress(state);
  emitRuntimeProgress(
    options,
    task.progressPhase || "model_downloading",
    resolveDownloadProgressTitle(task, Boolean(state.completed)),
    `${task.label}: ${task.file}`,
    {
      progressMode:
        state.knownAggregateBytes || state.totalBytes
          ? "determinate"
          : "log-only",
      progressPercent: metrics.progressPercent,
      progressBytes: metrics.progressBytes,
      progressTotalBytes:
        state.knownAggregateBytes || state.totalBytes || undefined,
      progressBytesPerSecond: metrics.speed,
      installLogLine: state.completed
        ? `${task.label} 다운로드 완료: ${task.file} (${fileProgress})`
        : `${task.label} 다운로드 중: ${task.file} (${fileProgress})`,
    },
  );
}

/** @param {HfDownloadProgressState} state */
function calculateProgressMetrics(state) {
  const aggregateBytes = state.knownAggregateBytes
    ? Math.min(
        state.knownAggregateBytes,
        (state.aggregateCompletedBytes || 0) + state.receivedBytes,
      )
    : undefined;
  const fileBytes = state.totalBytes
    ? Math.min(state.receivedBytes, state.totalBytes)
    : undefined;
  const progressPercent =
    state.knownAggregateBytes && aggregateBytes !== undefined
      ? aggregateBytes / state.knownAggregateBytes
      : state.totalBytes && fileBytes !== undefined
        ? fileBytes / state.totalBytes
        : undefined;
  const elapsedSeconds = Math.max(0.001, (Date.now() - state.startedAt) / 1000);
  return {
    progressPercent,
    progressBytes: aggregateBytes ?? fileBytes,
    speed: Math.max(0, state.receivedBytes / elapsedSeconds),
  };
}

/** @param {HfDownloadProgressState} state */
function formatFileProgress(state) {
  return state.totalBytes
    ? `${formatBytes(state.receivedBytes)} / ${formatBytes(state.totalBytes)}`
    : `${formatBytes(state.receivedBytes)} 받음`;
}

/** @param {HfDownloadTask} task @param {boolean} completed */
function resolveDownloadProgressTitle(task, completed) {
  return completed
    ? task.completeTitle || `${task.label} 다운로드 완료`
    : task.progressTitle || `${task.label} 다운로드 중`;
}

module.exports = {
  emitDownloadRetryProgress,
  emitHfDownloadProgress,
  emitRangeFallbackProgress,
  resolveDownloadProgressTitle,
};
