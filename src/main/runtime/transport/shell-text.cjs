// @ts-check

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

/** @param {string} template @param {Record<string, string>} replacements */
function renderCommandTemplate(template, replacements) {
  let rendered = template;
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }
  return rendered;
}

/** @param {unknown} value */
function quoteCommandArg(value) {
  return `"${String(value ?? "").replace(/"/g, '\\"')}"`;
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
  quoteCommandArg,
  renderCommandTemplate,
  shrinkBuffer,
  truncateText,
};
