// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").ImageVariant} ImageVariant */
/** @typedef {import("./prompt-types").PromptSection} PromptSection */
/** @typedef {import("./prompt-types").PromptCoordinateFrame} PromptCoordinateFrame */
/** @typedef {import("./prompt-types").OcrHint} OcrHint */

const { readPositiveInteger } = require("./common.cjs");
const {
  convertOriginalPixelBoxToPromptFrame,
  resolvePromptCoordinateFrame,
} = require("./coordinates.cjs");
const {
  sanitizeOcrGroupId,
  sanitizeOcrGroupValue,
} = require("./ocr-groups.cjs");
const {
  readOcrCandidateText,
  sanitizeOcrTextForPrompt,
} = require("./ocr-text.cjs");

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {PromptSection}
 */
function buildRegionOcrReadingHintSection(options = {}, imageVariants = []) {
  const hints = Array.isArray(options.ocrBboxHints) ? options.ocrBboxHints : [];
  if (hints.length === 0) {
    return [];
  }

  const frame = resolvePromptCoordinateFrame(options, imageVariants);
  const originalWidth = readPositiveInteger(options.imageWidth);
  const originalHeight = readPositiveInteger(options.imageHeight);
  const formattedHints = hints
    .slice(0, 80)
    .map((hint, index) =>
      formatRegionOcrReadingHintForPrompt(
        hint,
        index + 1,
        frame,
        originalWidth,
        originalHeight,
        options,
      ),
    )
    .filter(Boolean);
  if (formattedHints.length === 0) {
    return [];
  }

  return [
    "OCR reading hints",
    "Use these crop-local OCR readings only as reference while reading Image 1.",
    "Image 1 is the authority for the actual Japanese text, bbox, and Korean translation.",
    "The box numbers below already use the Image 1 coordinate frame.",
    "",
    ...formattedHints,
  ];
}

/**
 * @param {OcrHint} hint
 * @param {number} fallbackIndex
 * @param {PromptCoordinateFrame} frame
 * @param {number | null} originalWidth
 * @param {number | null} originalHeight
 * @param {PromptOptions} [options]
 * @returns {string}
 */
function formatRegionOcrReadingHintForPrompt(
  hint,
  fallbackIndex,
  frame,
  originalWidth,
  originalHeight,
  options = {},
) {
  const x1 = Number(hint?.x1);
  const y1 = Number(hint?.y1);
  const x2 = Number(hint?.x2);
  const y2 = Number(hint?.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return "";
  }

  const converted = convertOriginalPixelBoxToPromptFrame(
    { x1, y1, x2, y2 },
    frame,
    originalWidth,
    originalHeight,
  );
  const ocrText = sanitizeOcrTextForPrompt(readOcrCandidateText(hint), options);
  const textHint = ocrText ? ` text:${JSON.stringify(ocrText)}` : "";
  const groupId = sanitizeOcrGroupId(hint.groupId);
  const group = groupId ? ` group:${groupId}` : "";
  const order = readPositiveInteger(hint.orderInGroup);
  const orderText = order ? ` order:${order}` : "";
  const rolePrior = sanitizeOcrGroupValue(hint.rolePrior);
  const role = rolePrior ? ` role:${rolePrior}` : "";
  const containerType = sanitizeOcrGroupValue(hint.containerType);
  const container = containerType ? ` container:${containerType}` : "";
  return `hint ${fallbackIndex}: box:[${converted.x1},${converted.y1},${converted.x2},${converted.y2}]${group}${orderText}${role}${container}${textHint}`;
}

module.exports = { buildRegionOcrReadingHintSection };
