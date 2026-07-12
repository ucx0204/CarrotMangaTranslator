// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").ImageVariant} ImageVariant */
/** @typedef {import("./prompt-types").PromptSection} PromptSection */
/** @typedef {import("./prompt-types").PreviousPromptBlock} PreviousPromptBlock */
/** @typedef {import("./prompt-types").PromptWorkContext} PromptWorkContext */
/** @typedef {import("./prompt-types").PromptBbox} PromptBbox */
/** @typedef {import("./prompt-types").PromptGlossaryEntry} PromptGlossaryEntry */

const {
  resolvePromptLanguageProfile,
} = require("../simple-page-language-profile.cjs");
const { readPositiveInteger, sanitizePromptLine } = require("./common.cjs");
const { resolvePromptCoordinateFrame } = require("./coordinates.cjs");
const {
  hasMixedJapaneseLatinNoise,
  normalizePromptAuditText,
} = require("./ocr-text.cjs");
const { sanitizeOcrGroupValue } = require("./ocr-groups.cjs");

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {PromptSection}
 */
function buildPreviousPassSection(options = {}, imageVariants = []) {
  const blocks = Array.isArray(options.previousBlocksForPrompt)
    ? options.previousBlocksForPrompt
    : [];
  if (!options.strictRefineMode || blocks.length === 0) {
    return [];
  }

  return [
    "Previous pass blocks",
    "These are weak review hints from the previous Korean overlay pass. Do not output them as records unless Image 1 shows real Japanese glyphs at the same physical area.",
    "They are useful for preserving good Korean wording, spotting bad splits/merges, and avoiding accidental deletion, but they are lower priority than Image 1, OCR candidates, and glossary entries.",
    "Previous jp/sourceText may be an OCR-derived hallucination too. If it contains Latin garbage, romanized ruby, odd stray katakana, duplicated aliases, or particles that do not match Image 1, ignore that text and re-read the glyphs.",
    ...(options.keepBlocksMode
      ? [
          "Each previous block lists the candidateId of its own user-defined slot. Output that candidate id for that block's record; never merge blocks or reassign text between slots.",
        ]
      : [
          "When adjacent previous blocks match one same-container OCR group, treat the earlier separate translations as split artifacts and produce one fresh combined translation.",
          "If a previous block and one or more OCR candidates describe the same physical area, output the OCR candidate id or merged representative candidate id, not a separate previous-block record.",
        ]),
    "If Image 1 does not show Japanese glyphs at a previous block location, ignore that previous block.",
    ...blocks
      .slice(0, 80)
      .map((block, index) =>
        formatPreviousPassBlock(block, index + 1, options, imageVariants),
      )
      .filter(Boolean),
  ];
}

/**
 * @param {PreviousPromptBlock} block
 * @param {number} fallbackIndex
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {string}
 */
function formatPreviousPassBlock(
  block,
  fallbackIndex,
  options = {},
  imageVariants = [],
) {
  if (!block || typeof block !== "object") {
    return "";
  }
  const index = readPositiveInteger(block.index) || fallbackIndex;
  const bbox = convertPreviousBboxToPromptFrame(
    block.bbox,
    options,
    imageVariants,
  );
  if (!bbox) {
    return "";
  }
  const role = sanitizePromptLine(block.textRole || "ordinary", 40);
  const review = classifyPreviousPassTextForPrompt(block, options);
  const languageProfile = resolvePromptLanguageProfile(options);
  const candidate = formatCandidateId(block.candidateId);
  const confidence = formatConfidence(block.confidence);
  const reviewText = formatReviewText(review);
  const sourceText = formatReviewedText(
    block.sourceText,
    languageProfile.sourceKey,
    review.omitSource,
  );
  const targetText = formatReviewedText(
    block.translatedText,
    languageProfile.targetKey,
    review.omitTranslation,
  );
  return `previous ${index}:${candidate} bbox:[${bbox.x1},${bbox.y1},${bbox.x2},${bbox.y2}] role:${role}${confidence}${reviewText}${sourceText}${targetText}`;
}

/** @param {unknown} value @returns {string} */
function formatCandidateId(value) {
  const candidateId = readPositiveInteger(value);
  return candidateId ? ` candidateId:${candidateId}` : "";
}

/** @param {unknown} value @returns {string} */
function formatConfidence(value) {
  const confidence = Number(value);
  return Number.isFinite(confidence)
    ? ` confidence:${Math.round(confidence * 100) / 100}`
    : "";
}

/**
 * @param {{ omitSource: boolean; omitTranslation: boolean; reasons: string[] }} review
 * @returns {string}
 */
function formatReviewText(review) {
  if (review.reasons.length === 0) {
    return "";
  }
  const state =
    review.omitSource && review.omitTranslation ? "omitted" : "partial";
  return ` oldText:${state} reason:${JSON.stringify(review.reasons.join(";"))}`;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @param {boolean} omit
 * @returns {string}
 */
function formatReviewedText(value, key, omit) {
  const text = sanitizePromptLine(value, 160);
  return !omit && text ? ` ${key}:${JSON.stringify(text)}` : "";
}

/**
 * @param {PreviousPromptBlock} block
 * @param {PromptOptions} [options]
 * @returns {{ omitSource: boolean; omitTranslation: boolean; reasons: string[] }}
 */
function classifyPreviousPassTextForPrompt(block, options = {}) {
  const reasons = [];
  const candidateId = readPositiveInteger(block?.candidateId);
  if (
    candidateId &&
    isSameTextContainerOcrCandidate(candidateId, options.ocrBboxHints)
  ) {
    reasons.push("same_container_split");
  }

  const sourceText = normalizePromptAuditText(block?.sourceText);
  const translatedText = normalizePromptAuditText(block?.translatedText);
  const languageProfile = resolvePromptLanguageProfile(options);
  const glossaryConflict =
    languageProfile.targetBaseCode === "ko"
      ? findPreviousGlossaryConflict(
          sourceText,
          translatedText,
          options.workContext,
        )
      : "";
  if (glossaryConflict) {
    reasons.push(`glossary_conflict:${glossaryConflict}`);
  }
  if (
    languageProfile.sourceBaseCode === "ja" &&
    hasMixedJapaneseLatinNoise(sourceText)
  ) {
    reasons.push("mixed_latin_ocr_noise");
  }

  return {
    omitSource: reasons.length > 0,
    omitTranslation: reasons.length > 0,
    reasons,
  };
}

/**
 * @param {number} candidateId
 * @param {unknown[] | undefined} hints
 * @returns {boolean}
 */
function isSameTextContainerOcrCandidate(candidateId, hints) {
  if (!Array.isArray(hints)) {
    return false;
  }
  return hints.some((hint) => {
    if (!hint || typeof hint !== "object") {
      return false;
    }
    const record = /** @type {Record<string, unknown>} */ (hint);
    return (
      readPositiveInteger(record.id) === candidateId &&
      sanitizeOcrGroupValue(record.containerType) === "same_text_container"
    );
  });
}

/**
 * @param {string} sourceText
 * @param {string} translatedText
 * @param {PromptWorkContext | null | undefined} context
 * @returns {string}
 */
function findPreviousGlossaryConflict(sourceText, translatedText, context) {
  const glossary = Array.isArray(context?.styleGuide?.glossary)
    ? context.styleGuide.glossary
    : [];
  if (!sourceText || glossary.length === 0) {
    return "";
  }
  const compactKo = compactPromptAuditText(translatedText);
  for (const entry of glossary) {
    const conflict = findGlossaryEntryConflict(entry, sourceText, compactKo);
    if (conflict) {
      return conflict;
    }
  }
  return "";
}

/**
 * @param {PromptGlossaryEntry} entry
 * @param {string} sourceText
 * @param {string} compactTranslation
 * @returns {string}
 */
function findGlossaryEntryConflict(entry, sourceText, compactTranslation) {
  if (!entry || entry.enabled === false) {
    return "";
  }
  const target = normalizePromptAuditText(entry.target);
  const compactTarget = compactPromptAuditText(target);
  if (!target || !compactTarget || compactTranslation.includes(compactTarget)) {
    return "";
  }
  const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
  const matches = [entry.source, ...aliases]
    .map(normalizePromptAuditText)
    .filter(Boolean)
    .some((term) => sourceText.includes(term));
  return matches ? sanitizePromptLine(target, 80) : "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function compactPromptAuditText(value) {
  return normalizePromptAuditText(value).replace(/\s+/g, "");
}

/**
 * @param {PromptBbox | undefined} bbox
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {{ x1: number; y1: number; x2: number; y2: number } | null}
 */
function convertPreviousBboxToPromptFrame(
  bbox,
  options = {},
  imageVariants = [],
) {
  if (!bbox || typeof bbox !== "object") {
    return null;
  }
  const x = Number(bbox.x);
  const y = Number(bbox.y);
  const w = Number(bbox.w);
  const h = Number(bbox.h);
  if (![x, y, w, h].every(Number.isFinite)) {
    return null;
  }
  const frame = resolvePromptCoordinateFrame(options, imageVariants);
  const left = Math.min(x, x + w);
  const top = Math.min(y, y + h);
  const right = Math.max(x, x + w);
  const bottom = Math.max(y, y + h);
  if (frame.space === "pixels") {
    return {
      x1: Math.round((left / 1000) * frame.frame.width),
      y1: Math.round((top / 1000) * frame.frame.height),
      x2: Math.round((right / 1000) * frame.frame.width),
      y2: Math.round((bottom / 1000) * frame.frame.height),
    };
  }
  return {
    x1: Math.round(left),
    y1: Math.round(top),
    x2: Math.round(right),
    y2: Math.round(bottom),
  };
}

module.exports = { buildPreviousPassSection };
