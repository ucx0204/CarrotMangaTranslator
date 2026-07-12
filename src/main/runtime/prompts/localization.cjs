// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("../simple-page-language-profile.cjs").PromptLanguageProfile} PromptLanguageProfile */

const {
  resolvePromptLanguageProfile,
} = require("../simple-page-language-profile.cjs");

const JAPANESE_KANA_LINE_PATTERN = /[぀-ヿ]/;
const HANGUL_LINE_PATTERN = /[가-힯ᄀ-ᇿ]/;
const JAPANESE_TERM_LINE_PATTERN =
  /\b(kana|katakana|hiragana|furigana|ruby|dakuten|sokuon)\b/i;

/**
 * @param {string} line
 * @param {PromptLanguageProfile} profile
 * @returns {boolean}
 */
function isLanguagePairSpecificPromptLine(line, profile) {
  const hasJapaneseOnlyText =
    JAPANESE_KANA_LINE_PATTERN.test(line) ||
    JAPANESE_TERM_LINE_PATTERN.test(line);
  if (profile.sourceBaseCode !== "ja" && hasJapaneseOnlyText) {
    return true;
  }
  return profile.targetBaseCode !== "ko" && HANGUL_LINE_PATTERN.test(line);
}

/**
 * @param {string} line
 * @param {PromptLanguageProfile} profile
 * @returns {string}
 */
function substitutePromptLanguageTokens(line, profile) {
  return line
    .replace(/\b(?:Japanese|Korean)\b/g, (token) =>
      token === "Japanese" ? profile.sourceName : profile.targetName,
    )
    .replace(/\b(?:jp|ko)\b/g, (token) =>
      token === "jp" ? profile.sourceKey : profile.targetKey,
    );
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isDynamicPromptDataLine(line) {
  return (
    line.startsWith("- ") ||
    /^previous \d+:/.test(line) ||
    /^candidate \d+:/.test(line) ||
    /^group G\d{3,4}:/.test(line) ||
    /^hint \d+:/.test(line) ||
    /^\s+"(?:source|target)":/.test(line)
  );
}

/**
 * @param {string} line
 * @param {PromptLanguageProfile} profile
 * @returns {string}
 */
function adaptStaticPromptLineForProfile(line, profile) {
  if (profile.sourceBaseCode === "ja") {
    return line;
  }
  if (
    line.startsWith(
      "Skip records whose jp is only punctuation, decorative marks, page numbers, a lone Latin letter",
    )
  ) {
    return "Skip records whose jp is only punctuation, decorative marks, or an unreadable clipped glyph. Meaningful single letters, digits, and compact labels are valid source text.";
  }
  if (
    line.startsWith(
      "Never add new ordinary records for dots, dashes, ellipses, Latin letters, digits, UI fragments",
    )
  ) {
    return "Never add new ordinary records for decorative dots, dashes, panel trim, furniture lines, wall patterns, or unreadable isolated strokes. Meaningful single letters, digits, and compact UI labels are valid source text.";
  }
  if (
    line ===
    "Process panels and bubbles exhaustively from top to bottom and right to left."
  ) {
    return profile.sourceIsRtl
      ? line
      : "Process panels and bubbles exhaustively from top to bottom and left to right.";
  }
  return line;
}

/**
 * @param {string} text
 * @param {PromptLanguageProfile} profile
 * @returns {string}
 */
function localizePromptTextForProfile(text, profile) {
  if (profile.isDefaultJapaneseToKorean) {
    return text;
  }
  const localized = [];
  for (const line of text.split("\n")) {
    if (isDynamicPromptDataLine(line)) {
      localized.push(line);
      continue;
    }
    const adaptedLine = adaptStaticPromptLineForProfile(line, profile);
    if (!isLanguagePairSpecificPromptLine(adaptedLine, profile)) {
      localized.push(substitutePromptLanguageTokens(adaptedLine, profile));
    }
  }
  return localized.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * @param {string} text
 * @param {PromptOptions} [options]
 * @returns {string}
 */
function localizePrompt(text, options = {}) {
  return localizePromptTextForProfile(
    text,
    resolvePromptLanguageProfile(options),
  );
}

module.exports = { localizePrompt, localizePromptTextForProfile };
