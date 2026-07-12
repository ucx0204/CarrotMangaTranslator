// @ts-check

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function sanitizePromptLine(value, max = 240) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max
    ? text
    : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function readPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

module.exports = { readPositiveInteger, sanitizePromptLine };
