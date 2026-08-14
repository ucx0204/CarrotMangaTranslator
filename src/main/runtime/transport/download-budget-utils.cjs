// @ts-check
const {
  DEFAULT_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
  MAX_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
  MIN_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
} = require("./download-budgets.cjs");

/** @param {{ label?: unknown; file?: unknown; maximumBytes?: unknown }} task */
function assertDownloadMaximumBytes(task) {
  const maximumBytes = Number(task.maximumBytes);
  if (Number.isSafeInteger(maximumBytes) && maximumBytes > 0) return;
  const error = createDownloadError(
    `${String(task.label || "파일")} 다운로드 최대 크기가 올바르지 않습니다.`,
    task,
  );
  error.name = "DownloadBudgetError";
  error.code = "DOWNLOAD_BUDGET_INVALID";
  error.downloadBudgetInvalid = true;
  error.nonRetriable = true;
  throw error;
}

/** @param {{ label?: unknown; file?: unknown; maximumBytes?: unknown }} task @param {number} receivedBytes */
function assertDownloadSizeWithinBudget(task, receivedBytes) {
  assertDownloadMaximumBytes(task);
  const maximumBytes = Number(task.maximumBytes);
  if (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0) {
    const error = createDownloadError(
      `${String(task.label || "파일")} 다운로드 크기가 올바르지 않습니다.`,
      task,
    );
    error.name = "DownloadBudgetError";
    error.code = "DOWNLOAD_BUDGET_INVALID";
    error.downloadBudgetInvalid = true;
    error.nonRetriable = true;
    throw error;
  }
  if (receivedBytes > maximumBytes) {
    throw createDownloadBudgetError(task, maximumBytes, receivedBytes);
  }
}

/** @param {{ label?: unknown; file?: unknown }} task @param {number} maximumBytes @param {number} receivedBytes */
function createDownloadBudgetError(task, maximumBytes, receivedBytes) {
  const error = createDownloadError(
    `${String(task.label || "파일")} 다운로드가 허용 크기 ${maximumBytes} bytes를 초과했습니다.`,
    task,
  );
  error.name = "DownloadBudgetError";
  error.code = "DOWNLOAD_BUDGET_EXCEEDED";
  error.downloadBudgetExceeded = true;
  error.nonRetriable = true;
  error.maximumBytes = maximumBytes;
  error.receivedBytes = receivedBytes;
  return error;
}

/** @param {unknown} error */
function isDownloadBudgetError(error) {
  const detail = errorRecord(error);
  return Boolean(
    detail &&
    (detail.downloadBudgetExceeded === true ||
      detail.downloadBudgetInvalid === true),
  );
}

/** @param {unknown} error */
function isDownloadDeadlineError(error) {
  return errorRecord(error)?.downloadDeadlineExceeded === true;
}

/** @param {{ label?: unknown; file?: unknown }} task @param {number} timeoutMs */
function createDownloadDeadlineError(task, timeoutMs) {
  const error = createDownloadError(
    `${String(task.label || "파일")} 다운로드가 절대 제한 시간 ${timeoutMs}ms를 초과했습니다.`,
    task,
  );
  error.name = "DownloadDeadlineError";
  error.code = "DOWNLOAD_DEADLINE_EXCEEDED";
  error.downloadDeadlineExceeded = true;
  error.nonRetriable = true;
  error.timeoutMs = timeoutMs;
  return error;
}

/** @param {Record<string, unknown>} [options] */
function resolveDownloadAbsoluteTimeoutMs(options = {}) {
  const requested = readPositiveInteger(
    options.downloadAbsoluteTimeoutMs ??
      process.env.MANGA_TRANSLATOR_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
  );
  return Math.min(
    MAX_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
    Math.max(
      MIN_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
      requested || DEFAULT_DOWNLOAD_ABSOLUTE_TIMEOUT_MS,
    ),
  );
}

/** @param {AbortSignal | null | undefined} parentSignal @param {number} timeoutMs @param {{ label?: unknown; file?: unknown }} task */
function createDownloadDeadline(parentSignal, timeoutMs, task) {
  assertPositiveSafeInteger(timeoutMs, "downloadAbsoluteTimeoutMs");
  const controller = new AbortController();
  const state = { timedOut: false, cleaned: false };
  const onParentAbort = () => abortWithParentReason(controller, parentSignal);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });
  const timeout = setTimeout(() => {
    state.timedOut = true;
    if (!controller.signal.aborted) {
      controller.abort(createDownloadDeadlineError(task, timeoutMs));
    }
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      if (state.cleaned) return;
      state.cleaned = true;
      clearTimeout(timeout);
      parentSignal?.removeEventListener?.("abort", onParentAbort);
    },
    didTimeOut() {
      return state.timedOut;
    },
  };
}

/** @param {AbortController} controller @param {AbortSignal | null | undefined} parentSignal */
function abortWithParentReason(controller, parentSignal) {
  if (!controller.signal.aborted)
    controller.abort(readAbortReason(parentSignal));
}

/** @param {string} message @param {{ file?: unknown }} task */
function createDownloadError(message, task) {
  const error = /** @type {Error & Record<string, unknown>} */ (
    new Error(message)
  );
  error.file = String(task.file || "");
  return error;
}

/** @param {unknown} error */
function errorRecord(error) {
  return error && typeof error === "object"
    ? /** @type {Record<string, unknown>} */ (error)
    : null;
}

/** @param {number} value @param {string} name */
function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

/** @param {unknown} value */
function readPositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

/** @param {AbortSignal | null | undefined} signal */
function readAbortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("작업이 취소되었습니다.");
  error.name = "AbortError";
  return error;
}

module.exports = {
  assertDownloadMaximumBytes,
  assertDownloadSizeWithinBudget,
  createDownloadBudgetError,
  createDownloadError,
  createDownloadDeadline,
  createDownloadDeadlineError,
  isDownloadBudgetError,
  isDownloadDeadlineError,
  resolveDownloadAbsoluteTimeoutMs,
};
