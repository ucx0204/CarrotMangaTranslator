// @ts-check

/** @param {unknown} value @returns {boolean} */
function isTruthy(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

/** @param {unknown} value @returns {number} */
function readPositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
function truncateText(value, maxLength = 1200) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

/** @param {unknown} value @returns {string} */
function readOptionString(value) {
  return String(value ?? "").trim();
}

/** @param {unknown} value @returns {number} */
function readPositiveIntegerOption(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

module.exports = {
  isTruthy,
  readOptionString,
  readPositiveInteger,
  readPositiveIntegerOption,
  truncateText,
};
