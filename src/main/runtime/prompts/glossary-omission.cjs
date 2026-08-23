// @ts-check

/** @param {unknown} values @returns {string[]} */
function normalizeGlossaryOmissionTerms(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizeTerm).filter(Boolean))].sort(
    (left, right) =>
      Array.from(right).length - Array.from(left).length ||
      left.localeCompare(right),
  );
}

/** @param {unknown} value @returns {string} */
function normalizeTerm(value) {
  return String(value ?? "").trim();
}

/**
 * Removes only the prompt copy. Stored OCR/source fields remain untouched.
 * At each cursor, longest-first sorting makes overlapping terms deterministic.
 *
 * @param {unknown} value
 * @param {unknown} rawTerms
 * @returns {string}
 */
function omitGlossaryTermsFromPromptText(value, rawTerms) {
  const text = String(value ?? "");
  const terms = normalizeGlossaryOmissionTerms(rawTerms);
  if (!text || terms.length === 0) return text;
  let cursor = 0;
  let output = "";
  while (cursor < text.length) {
    const matched = terms.find((term) => text.startsWith(term, cursor));
    if (!matched) {
      output += text[cursor];
      cursor += 1;
      continue;
    }
    cursor += matched.length;
  }
  return output
    .replace(/[\t ]{2,}/g, " ")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .trim();
}

module.exports = {
  normalizeGlossaryOmissionTerms,
  omitGlossaryTermsFromPromptText,
};
