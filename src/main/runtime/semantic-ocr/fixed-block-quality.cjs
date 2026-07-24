// @ts-check

const {
  isJapaneseLanguageCode,
  resolvePromptLanguageProfile,
} = require("../simple-page-language-profile.cjs");
const { semanticContractError } = require("./values.cjs");

const LOW_CONFIDENCE_NOISE_REASONS = new Set([
  "ambiguous_low_confidence_shape",
  "dense_page_single_glyph",
  "low_confidence_no_bridge",
  "low_confidence_short_text",
  "small_low_confidence_text",
]);
const SOURCE_SCRIPT_FAMILIES = {
  ja: [
    {
      pattern: /[\p{Script=Hiragana}\p{Script=Katakana}\uFF66-\uFF9F]/u,
      targetCodes: new Set(["ja"]),
    },
    {
      pattern: /\p{Script=Han}/u,
      targetCodes: new Set(["ja", "zh"]),
    },
    {
      pattern: /[々〆ヶー]/u,
      targetCodes: new Set(["ja"]),
    },
  ],
  zh: [
    {
      pattern: /\p{Script=Han}/u,
      targetCodes: new Set(["ja", "zh"]),
    },
  ],
  ko: [
    {
      pattern: /\p{Script=Hangul}/u,
      targetCodes: new Set(["ko"]),
    },
  ],
  ar: [sharedScript(/\p{Script=Arabic}/u, ["ar", "fa", "ur"])],
  fa: [sharedScript(/\p{Script=Arabic}/u, ["ar", "fa", "ur"])],
  ur: [sharedScript(/\p{Script=Arabic}/u, ["ar", "fa", "ur"])],
  bg: [sharedScript(/\p{Script=Cyrillic}/u, ["bg", "mn", "ru", "sr", "uk"])],
  mn: [sharedScript(/\p{Script=Cyrillic}/u, ["bg", "mn", "ru", "sr", "uk"])],
  ru: [sharedScript(/\p{Script=Cyrillic}/u, ["bg", "mn", "ru", "sr", "uk"])],
  sr: [sharedScript(/\p{Script=Cyrillic}/u, ["bg", "mn", "ru", "sr", "uk"])],
  uk: [sharedScript(/\p{Script=Cyrillic}/u, ["bg", "mn", "ru", "sr", "uk"])],
  bn: [sharedScript(/\p{Script=Bengali}/u, ["bn"])],
  el: [sharedScript(/\p{Script=Greek}/u, ["el"])],
  he: [sharedScript(/\p{Script=Hebrew}/u, ["he"])],
  hi: [sharedScript(/\p{Script=Devanagari}/u, ["hi"])],
  ka: [sharedScript(/\p{Script=Georgian}/u, ["ka"])],
  km: [sharedScript(/\p{Script=Khmer}/u, ["km"])],
  lo: [sharedScript(/\p{Script=Lao}/u, ["lo"])],
  my: [sharedScript(/\p{Script=Myanmar}/u, ["my"])],
  ta: [sharedScript(/\p{Script=Tamil}/u, ["ta"])],
  te: [sharedScript(/\p{Script=Telugu}/u, ["te"])],
  th: [sharedScript(/\p{Script=Thai}/u, ["th"])],
};

/**
 * @typedef {{id:number;score:number|null;[key:string]:unknown}} QualityCandidate
 * @typedef {{blockId:string;ko:string}} QualityTranslation
 * @typedef {{blockId:string;jp:string;confidence:number;soundCandidate:boolean}} QualityBlock
 * @typedef {{sourceLanguage?:unknown;targetLanguage?:unknown;[key:string]:unknown}} QualityOptions
 * @typedef {{pattern:RegExp;targetCodes:Set<string>}} ScriptFamily
 */

/**
 * Latin is intentionally not treated as forbidden source script because
 * names, product labels, and abbreviations legitimately survive in nearly
 * every target language.
 *
 * @param {RegExp} pattern
 * @param {string[]} targetCodes
 * @returns {ScriptFamily}
 */
function sharedScript(pattern, targetCodes) {
  return { pattern, targetCodes: new Set(targetCodes) };
}

/**
 * The grouping model is deliberately not allowed to discard OCR candidates.
 * Remove a final group only when every member still carries Paddle's explicit
 * deferred low-confidence classification.
 *
 * @param {QualityCandidate[]} members
 * @param {Map<number,Record<string,unknown>>} hintById
 * @param {QualityOptions} options
 */
function isRejectedLowConfidenceNoiseGroup(members, hintById, options) {
  if (!isJapaneseLanguageCode(options.sourceLanguage) || members.length === 0)
    return false;
  return members.every((member) =>
    isRejectedLowConfidenceNoiseMember(member, hintById.get(member.id)),
  );
}

/**
 * @param {QualityCandidate} member
 * @param {Record<string,unknown>|undefined} hint
 */
function isRejectedLowConfidenceNoiseMember(member, hint) {
  if (!hint || hint.reviewStatus !== "deferred" || member.score === null)
    return false;
  const reasons = Array.isArray(hint.reviewReasons)
    ? hint.reviewReasons.map(String)
    : [];
  // Paddle assigns this reason only after the candidate has already failed
  // its size-aware SFX/display approval threshold.
  if (reasons.includes("oversized_uncertain_sfx")) return true;
  return (
    reasons.some((reason) => LOW_CONFIDENCE_NOISE_REASONS.has(reason)) &&
    member.score < 0.58
  );
}

/**
 * Reject source-script leakage instead of trying to transliterate it in
 * postprocessing. The ordinary page retry can then ask the translator again
 * while reusing the cached grouping result.
 *
 * @param {QualityTranslation[]} items
 * @param {QualityOptions} options
 */
function validateFixedBlockTargetLanguage(items, options) {
  const leaked = findFixedBlockTargetLanguageViolations(items, options)[0];
  if (!leaked) return;
  const profile = resolvePromptLanguageProfile(options);
  throw semanticContractError(
    "fixed-block-translation-source-script-leak",
    `Fixed-block translation ${leaked.blockId} contains untranslated ${profile.sourceName} script in ${profile.targetName} output.`,
  );
}

/**
 * Distinctive source scripts are rejected only when the target language does
 * not normally share that script. Shared Han in Chinese/Japanese is therefore
 * allowed, while Chinese Han copied into Korean or English remains repairable.
 *
 * @param {QualityTranslation[]} items
 * @param {QualityOptions} options
 * @returns {QualityTranslation[]}
 */
function findFixedBlockTargetLanguageViolations(items, options) {
  const profile = resolvePromptLanguageProfile(options);
  if (profile.sourceBaseCode === profile.targetBaseCode) return [];
  const families =
    SOURCE_SCRIPT_FAMILIES[
      /** @type {keyof typeof SOURCE_SCRIPT_FAMILIES} */ (
        profile.sourceBaseCode
      )
    ] ?? [];
  const forbidden = families
    .filter((family) => !family.targetCodes.has(profile.targetBaseCode))
    .map((family) => family.pattern);
  if (forbidden.length === 0) return [];
  return items.filter((item) =>
    forbidden.some((pattern) => pattern.test(item.ko)),
  );
}

/** @param {QualityBlock} block */
function resolveFixedBlockConfidence(block) {
  if (!block.soundCandidate) return block.confidence;
  const glyphCount = Array.from(block.jp.replace(/\s/gu, "")).length;
  const approvalThreshold = glyphCount <= 1 ? 0.88 : 0.82;
  return block.confidence >= approvalThreshold ? 1 : block.confidence;
}

module.exports = {
  findFixedBlockTargetLanguageViolations,
  isRejectedLowConfidenceNoiseGroup,
  resolveFixedBlockConfidence,
  validateFixedBlockTargetLanguage,
};
