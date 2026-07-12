// @ts-check
const { MAX_LOG_PREVIEW_LENGTH } = require("./simple-page-defaults.cjs");

function nowMs() {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
function truncateText(value, maxLength = MAX_LOG_PREVIEW_LENGTH) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

/**
 * @param {string} message
 * @param {Record<string, unknown>} [detail]
 * @param {unknown} [cause]
 * @returns {Error & Record<string, unknown>}
 */
function createDetailedError(message, detail = {}, cause) {
  const error = /** @type {Error & Record<string, unknown>} */ (
    new Error(message)
  );
  if (cause !== undefined) {
    error.cause = cause;
  }
  Object.assign(error, detail);
  return error;
}

/**
 * @param {string} label
 * @param {() => Promise<void> | void} cleanup
 * @returns {Promise<void>}
 */
async function safeCleanup(label, cleanup) {
  try {
    await cleanup();
  } catch (error) {
    console.warn(`[manga-runtime] Cleanup failed: ${label}`, error);
  }
}

/**
 * @param {object} options
 * @param {string} phase
 * @param {string} progressText
 * @param {string | undefined} [detail]
 * @param {Record<string, unknown>} [progress]
 * @returns {void}
 */
function emitRuntimeProgress(
  options = {},
  phase,
  progressText,
  detail,
  progress = {},
) {
  const onProgress =
    "onProgress" in options && typeof options.onProgress === "function"
      ? /** @type {(progress: Record<string, unknown>) => void} */ (
          options.onProgress
        )
      : null;
  if (!onProgress) {
    return;
  }
  try {
    onProgress({ phase, progressText, detail, ...progress });
  } catch (_error) {
    // error-policy-allow: observer failures must never interrupt translation.
  }
}

module.exports = {
  createDetailedError,
  emitRuntimeProgress,
  nowMs,
  safeCleanup,
  truncateText,
};
