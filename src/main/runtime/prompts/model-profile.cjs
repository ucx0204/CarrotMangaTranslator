// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */

/**
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
function truncateText(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

/**
 * @param {PromptOptions} [options]
 * @returns {boolean}
 */
function isOpenAICodexProvider(options = {}) {
  return String(options.modelProvider ?? "").trim() === "openai-codex";
}

/**
 * @param {PromptOptions} [options]
 * @returns {boolean}
 */
function shouldUseSmallGemmaDuplicatePromptProfile(options = {}) {
  if (isOpenAICodexProvider(options)) {
    return false;
  }
  const modelText = [
    options.modelRepo,
    options.modelFile,
    options.localModelPath,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /(^|[^0-9])(12b|26b)([^0-9]|$)|26b-a4b/.test(modelText);
}

const SMALL_GEMMA_DUPLICATE_OUTPUT_LINES = [
  "One physical Japanese text area may appear only once in the output. Never output multiple records whose boxes sit on the same glyph cluster, same speech bubble text, same caption text, or same SFX group.",
  "If two possible records would occupy the same place or mostly cover the same visible glyphs, keep one record only. Put all readable source lines for that same area into that one jp field and one Korean translation.",
  "Never stack several records at the same x/y position to represent separate lines, columns, words, or fragments inside one visual text area.",
  "Never output a later correction record that repeats, contains, or is contained by the jp text of an earlier record from the same visual area. Correct the original record instead of adding another one.",
];

const SMALL_GEMMA_DUPLICATE_SEGMENTATION_LINES = [
  "Inside one speech bubble, caption box, note, sign, label, or one continuous SFX glyph group, do not create overlapping records for separate columns, lines, words, or fragments. Same physical place means one record.",
];

const SMALL_GEMMA_OCR_ANCHOR_LINES = [
  "OCR text hints may be wrong, incomplete, or split strangely, but treat the OCR candidate rectangles as your primary geometry anchors unless Image 1 clearly proves otherwise.",
  "Compared with pure visual guessing, trust the OCR candidate placement and grouping more strongly: about 70% OCR geometry anchor, 30% visual correction from Image 1. This ratio is for geometry/grouping only; the actual jp/ko text must be freshly checked against Image 1.",
  "Use the OCR text hint and candidate rectangle together to keep each translated record attached to the correct candidate id, especially when nearby candidates are close together.",
];

const SMALL_GEMMA_OCR_DUPLICATE_LINES = [
  "Each candidate id is single-use. A candidate rectangle can produce at most one output record, even when the text has several vertical columns or several visible lines.",
  "Do not create another record whose bbox sits on the same place as an accepted candidate. If the text is inside or mostly inside a candidate rectangle, it belongs to that candidate id, or to the representative first reading-order id when same-container candidates are merged.",
  "Before adding any new record, compare it against every candidate bbox. If the new bbox would cover the same glyph cluster or the same visual text area as a candidate, keep the candidate record only.",
  "If one OCR candidate covers several Japanese lines or columns inside the same visual container, keep them as one record for that candidate; do not split them into multiple overlapping records.",
  "New ids are for genuinely missed text only, not for correcting, enlarging, summarizing, or re-reading an existing candidate. If a candidate needs a better jp/ko, fix that candidate record with the same id.",
  "A new id is invalid if its jp repeats, partially repeats, or summarizes text already assigned to a candidate or earlier record in the same speech bubble/caption/SFX area.",
];

module.exports = {
  SMALL_GEMMA_DUPLICATE_OUTPUT_LINES,
  SMALL_GEMMA_DUPLICATE_SEGMENTATION_LINES,
  SMALL_GEMMA_OCR_ANCHOR_LINES,
  SMALL_GEMMA_OCR_DUPLICATE_LINES,
  isOpenAICodexProvider,
  shouldUseSmallGemmaDuplicatePromptProfile,
  truncateText,
};
