const { MAX_LOG_PREVIEW_LENGTH } = require("./simple-page-defaults.cjs");

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function truncateText(value, maxLength = MAX_LOG_PREVIEW_LENGTH) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

function createDetailedError(message, detail = {}, cause) {
  const error = new Error(message);
  if (cause !== undefined) {
    error.cause = cause;
  }
  Object.assign(error, detail);
  return error;
}

function emitRuntimeProgress(options = {}, phase, progressText, detail, progress = {}) {
  if (typeof options.onProgress !== "function") {
    return;
  }
  try {
    options.onProgress({ phase, progressText, detail, ...progress });
  } catch {
    // Progress reporting must never interrupt translation.
  }
}

module.exports = {
  createDetailedError,
  emitRuntimeProgress,
  nowMs,
  truncateText
};
