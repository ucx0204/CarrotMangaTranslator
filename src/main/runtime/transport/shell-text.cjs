// @ts-check
/** @typedef {import("../runtime-jsdoc-types").CommandSpec} CommandSpec */

/** @param {unknown} value @param {number} [maxLength] */
function truncateText(value, maxLength = 8000) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

/** @param {string} message @param {Record<string, unknown>} [detail] @param {unknown} [cause] */
function createDetailedError(message, detail = {}, cause) {
  const error = new Error(message);
  if (cause !== undefined) error.cause = cause;
  Object.assign(error, detail);
  return error;
}

/** @param {string} current @param {unknown} chunk @param {number} [maxLength] */
function shrinkBuffer(current, chunk, maxLength = 12000) {
  const next = `${current}${String(chunk)}`;
  return next.length > maxLength ? next.slice(next.length - maxLength) : next;
}

/** @param {unknown} value @returns {CommandSpec} */
function normalizeCommandSpec(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Command spec must be an object.");
  }

  const candidate = /** @type {{ executable?: unknown; args?: unknown }} */ (
    value
  );

  if (
    typeof candidate.executable !== "string" ||
    !candidate.executable.trim()
  ) {
    throw new TypeError("Command executable must be a non-empty string.");
  }
  if (candidate.executable.includes("\0")) {
    throw new TypeError("Command executable must not contain NUL bytes.");
  }
  if (!Array.isArray(candidate.args)) {
    throw new TypeError("Command args must be an array of strings.");
  }

  for (const [index, arg] of candidate.args.entries()) {
    if (typeof arg !== "string") {
      throw new TypeError(`Command arg ${index} must be a string.`);
    }
    if (arg.includes("\0")) {
      throw new TypeError(`Command arg ${index} must not contain NUL bytes.`);
    }
  }

  return {
    executable: candidate.executable,
    args: [...candidate.args],
  };
}

/**
 * Logs and diagnostics only. Never pass this string to a process execution API.
 * @param {CommandSpec} command
 * @returns {string}
 */
function formatCommandForLog(command) {
  const normalized = normalizeCommandSpec(command);
  return [normalized.executable, ...normalized.args]
    .map((part) => JSON.stringify(part))
    .join(" ");
}

/** @returns {Error | DOMException} */
function createAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("Aborted", "AbortError");
  }
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

module.exports = {
  createAbortError,
  createDetailedError,
  formatCommandForLog,
  normalizeCommandSpec,
  shrinkBuffer,
  truncateText,
};
