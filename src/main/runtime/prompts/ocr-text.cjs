// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").PromptWorkContext} PromptWorkContext */
/** @typedef {import("./prompt-types").PromptGlossaryEntry} PromptGlossaryEntry */

const {
  resolvePromptLanguageProfile,
} = require("../simple-page-language-profile.cjs");
const { truncateText } = require("./model-profile.cjs");
const { omitGlossaryTermsFromPromptText } = require("./glossary-omission.cjs");

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizePromptAuditText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeHintLabel(value) {
  const text = String(value ?? "text")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  return text || "text";
}

/**
 * @param {unknown} candidate
 * @returns {string}
 */
function readOcrCandidateText(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return "";
  }
  const record = /** @type {Record<string, unknown>} */ (candidate);
  for (const key of [
    "ocrText",
    "ocr_text",
    "text",
    "content",
    "block_content",
    "rec_text",
    "transcription",
  ]) {
    const text = normalizeOcrTextValue(record[key]);
    if (text) {
      return text;
    }
  }
  return "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeOcrTextValue(value) {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeOcrTextValue).filter(Boolean).join(" ").trim();
  }
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    for (const key of [
      "text",
      "content",
      "value",
      "rec_text",
      "transcription",
    ]) {
      const text = normalizeOcrTextValue(record[key]);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

/**
 * @param {unknown} value
 * @param {PromptOptions} [options]
 * @returns {string}
 */
function sanitizeOcrTextForPrompt(value, options = {}) {
  const normalized = normalizeOcrTextValue(value);
  const sourceText =
    resolvePromptLanguageProfile(options).sourceBaseCode === "ja"
      ? removeGlossaryDuplicateRubyNoise(
          removeMixedJapaneseLatinNoise(normalized),
          options.workContext,
        )
      : normalized;
  const promptSourceText = omitGlossaryTermsFromPromptText(
    sourceText,
    options.glossaryOmissionTerms,
  );
  return truncateText(
    promptSourceText
      .replace(/[\u0000-\u001F\u007F]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    160,
  );
}

/**
 * @param {string} text
 * @param {PromptWorkContext | null | undefined} context
 * @returns {string}
 */
function removeGlossaryDuplicateRubyNoise(text, context) {
  const normalized = String(text || "");
  if (!normalized || !/\s/.test(normalized)) {
    return normalized;
  }
  const glossary = Array.isArray(context?.styleGuide?.glossary)
    ? context.styleGuide.glossary
    : [];
  let tokens = normalized.split(/\s+/).filter(Boolean);
  for (const entry of glossary) {
    tokens = removeRubyNoiseForEntry(tokens, normalized, entry);
  }
  return tokens.join(" ");
}

/**
 * @param {string[]} tokens
 * @param {string} normalized
 * @param {PromptGlossaryEntry} entry
 * @returns {string[]}
 */
function removeRubyNoiseForEntry(tokens, normalized, entry) {
  if (!entry || entry.enabled === false) {
    return tokens;
  }
  const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
  const terms = [entry.source, ...aliases]
    .map(normalizePromptAuditText)
    .filter(Boolean);
  const mainTerms = terms.filter((term) => !isKatakanaHeavy(term));
  if (!mainTerms.some((term) => normalized.includes(term))) {
    return tokens;
  }
  const katakanaTerms = terms.filter(isKatakanaHeavy);
  const filtered = tokens.filter(
    (token) =>
      !isKatakanaHeavy(token) ||
      !katakanaTerms.some((term) => areSimilarKatakanaTokens(token, term)),
  );
  return filtered.length === tokens.length
    ? tokens
    : removeTrailingRubyOrphanKanaTokens(filtered, mainTerms);
}

/**
 * @param {string[]} tokens
 * @param {string[]} mainTerms
 * @returns {string[]}
 */
function removeTrailingRubyOrphanKanaTokens(tokens, mainTerms) {
  if (tokens.length < 2) {
    return tokens;
  }
  const tail = tokens[tokens.length - 1] || "";
  const beforeTail = tokens[tokens.length - 2] || "";
  if (!isShortHiraganaOnlyToken(tail)) {
    return tokens;
  }
  if (!/[のがはをにへともで]$/.test(beforeTail)) {
    return tokens;
  }
  if (!mainTerms.some((term) => beforeTail.includes(term))) {
    return tokens;
  }
  return tokens.slice(0, -1);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isShortHiraganaOnlyToken(value) {
  const text = normalizePromptAuditText(value);
  return /^[\u3040-\u309f]{2,3}$/.test(text);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isKatakanaHeavy(value) {
  const text = normalizePromptAuditText(value);
  const katakanaChars = (text.match(/[\u30a0-\u30ff]/g) || []).length;
  return katakanaChars >= 3 && katakanaChars / Math.max(1, text.length) >= 0.6;
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function areSimilarKatakanaTokens(left, right) {
  const a = normalizeKatakanaForComparison(left);
  const b = normalizeKatakanaForComparison(right);
  if (!a || !b) {
    return false;
  }
  if (a.includes(b) || b.includes(a)) {
    return true;
  }
  const aChars = [...a];
  const bChars = [...b];
  const remaining = [...bChars];
  let common = 0;
  for (const char of aChars) {
    const index = remaining.indexOf(char);
    if (index >= 0) {
      common += 1;
      remaining.splice(index, 1);
    }
  }
  return common / Math.max(1, Math.min(aChars.length, bChars.length)) >= 0.75;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeKatakanaForComparison(value) {
  return String(value || "")
    .replace(/[^\u30a0-\u30ff]/g, "")
    .replace(/[ー・]/g, "")
    .trim();
}

/**
 * @param {string} text
 * @returns {string}
 */
function removeMixedJapaneseLatinNoise(text) {
  const normalized = String(text || "");
  if (!hasMixedJapaneseLatinNoise(normalized)) {
    return normalized;
  }
  return normalized
    .replace(/\b[A-Za-z][A-Za-z0-9'_-]{0,24}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasMixedJapaneseLatinNoise(value) {
  const text = String(value || "");
  if (!/[A-Za-z]/.test(text) || !/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) {
    return false;
  }
  const latinChars = (text.match(/[A-Za-z]/g) || []).length;
  const japaneseChars = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || [])
    .length;
  return japaneseChars >= 2 && latinChars <= Math.max(24, japaneseChars * 2);
}

module.exports = {
  hasMixedJapaneseLatinNoise,
  normalizePromptAuditText,
  readOcrCandidateText,
  sanitizeHintLabel,
  sanitizeOcrTextForPrompt,
};
