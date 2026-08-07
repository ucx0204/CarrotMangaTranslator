// @ts-check

/** @param {string} label @param {number} timeoutMs */
function createRequestDeadlineError(label, timeoutMs) {
  const error = /** @type {Error & Record<string, unknown>} */ (
    new Error(`${label} request exceeded ${timeoutMs} ms.`)
  );
  error.name = "HttpRequestDeadlineError";
  error.code = "HTTP_REQUEST_DEADLINE_EXCEEDED";
  error.nonRetriable = true;
  error.requestDeadlineExceeded = true;
  error.failureCategory = "model-request";
  error.timeoutMs = timeoutMs;
  return error;
}

/**
 * @param {AbortSignal | null | undefined} parentSignal
 * @param {number} timeoutMs
 * @param {string} label
 */
function createLinkedDeadlineController(parentSignal, timeoutMs, label) {
  assertPositiveSafeInteger(timeoutMs, "timeoutMs");
  const controller = new AbortController();
  let timedOut = false;
  let cleaned = false;
  const onParentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(readAbortReason(parentSignal));
    }
  };

  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) {
      controller.abort(createRequestDeadlineError(label, timeoutMs));
    }
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timeout);
      parentSignal?.removeEventListener?.("abort", onParentAbort);
    },
    didTimeOut() {
      return timedOut;
    },
  };
}

/** @param {number} value @param {string} name */
function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

/** @param {AbortSignal | null | undefined} signal */
function readAbortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

module.exports = {
  createLinkedDeadlineController,
  createRequestDeadlineError,
};
