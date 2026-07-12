// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").PromptSection} PromptSection */
/** @typedef {import("./prompt-types").OcrHint} OcrHint */
/** @typedef {import("./prompt-types").OcrHintGroup} OcrHintGroup */

const { readPositiveInteger } = require("./common.cjs");
const {
  readOcrCandidateText,
  sanitizeOcrTextForPrompt,
} = require("./ocr-text.cjs");

/**
 * @param {OcrHint[]} hints
 * @param {PromptOptions} [options]
 * @returns {PromptSection}
 */
function buildOcrGroupContextLines(hints, options = {}) {
  const groups = collectOcrHintGroups(hints);
  if (groups.length === 0) {
    return [];
  }

  return [
    "Group context hints:",
    "Some OCR candidates may be parts of the same visible utterance or related printed text. Use group context to read them in Japanese reading order before translating.",
    "For group containerType same_text_container, treat the grouped ordinary candidates as one visual text container unless Image 1 clearly shows separate bubbles/lobes/plates. Output one merged record with the first reading-order candidate id and omit the other grouped ids.",
    "For same_text_container groups, the textPreview in reading order is stronger than previous-pass jp/ko for those candidate ids. Verify it against Image 1, then translate the corrected combined expression from scratch.",
    "For group containerType possible_continuing_text, use the group mainly for coherent reading. Merge only if Image 1 clearly shows one speech bubble/caption/container; otherwise keep separate candidate records.",
    "For grouped ordinary text, first understand the combined Japanese expression in reading order. Do not translate each fragment syllable-by-syllable in isolation, and do not add meaning from earlier separate Korean fragments.",
    ...groups.map((group) => formatOcrGroupForPrompt(group, options)),
  ];
}

/**
 * @param {OcrHint[]} hints
 * @returns {OcrHintGroup[]}
 */
function collectOcrHintGroups(hints) {
  /** @type {Map<string, OcrHintGroup>} */
  const grouped = new Map();
  for (const hint of Array.isArray(hints) ? hints : []) {
    const groupId = sanitizeOcrGroupId(hint?.groupId);
    if (!groupId) continue;
    const group = grouped.get(groupId) || {
      groupId,
      rolePrior: sanitizeOcrGroupValue(hint.rolePrior) || "unknown",
      containerType: sanitizeOcrGroupValue(hint.containerType) || "unknown",
      hints: [],
    };
    group.hints.push(hint);
    grouped.set(groupId, group);
  }

  return [...grouped.values()]
    .map((group) => ({
      ...group,
      hints: group.hints
        .slice()
        .sort(
          (left, right) =>
            (readPositiveInteger(left.orderInGroup) || 9999) -
            (readPositiveInteger(right.orderInGroup) || 9999),
        ),
    }))
    .filter((group) => group.hints.length > 1)
    .sort((left, right) => left.groupId.localeCompare(right.groupId))
    .slice(0, 12);
}

/**
 * @param {OcrHintGroup} group
 * @param {PromptOptions} [options]
 * @returns {string}
 */
function formatOcrGroupForPrompt(group, options = {}) {
  const candidateIds = group.hints
    .map((hint) => readPositiveInteger(hint.id))
    .filter(Boolean);
  const readingOrder = group.hints
    .map((hint) => readPositiveInteger(hint.id))
    .filter(Boolean);
  const textPreview = group.hints
    .map((hint) =>
      sanitizeOcrTextForPrompt(readOcrCandidateText(hint), options),
    )
    .filter(Boolean)
    .join(" / ");
  const preview = textPreview
    ? ` textPreview:${JSON.stringify(textPreview)}`
    : "";
  return `group ${group.groupId}: rolePrior:${group.rolePrior} containerType:${group.containerType} candidateIds:[${candidateIds.join(",")}] readingOrder:[${readingOrder.join(",")}]${preview}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeOcrGroupId(value) {
  const text = String(value ?? "")
    .trim()
    .toUpperCase();
  return /^G\d{3,4}$/.test(text) ? text : "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeOcrGroupValue(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  return text.slice(0, 48);
}

module.exports = {
  buildOcrGroupContextLines,
  sanitizeOcrGroupId,
  sanitizeOcrGroupValue,
};
