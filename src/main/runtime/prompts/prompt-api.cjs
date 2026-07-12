// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").ImageVariant} ImageVariant */
/** @typedef {import("./prompt-types").PromptSection} PromptSection */

const { readPositiveInteger } = require("./common.cjs");
const { resolvePromptCoordinateFrame } = require("./coordinates.cjs");
const {
  readOcrCandidateText,
  sanitizeHintLabel,
  sanitizeOcrTextForPrompt,
} = require("./ocr-text.cjs");
const { buildOverlayPrompt } = require("./overlay-prompt.cjs");
const { buildSystemPrompt } = require("./system-prompt.cjs");
const { buildWorkContextSection } = require("./work-context.cjs");

/**
 * @param {PromptSection[]} baseSections
 * @returns {{
 *   PROMPT_KO_BBOX_LINES_MULTIVIEW: string;
 *   buildSystemPrompt: typeof buildSystemPrompt;
 *   buildWorkContextSection: typeof buildWorkContextSection;
 *   getOverlayPrompt: (options?: PromptOptions, imageVariants?: ImageVariant[]) => string;
 *   readOcrCandidateText: typeof readOcrCandidateText;
 *   readPositiveInteger: typeof readPositiveInteger;
 *   resolvePromptCoordinateFrame: typeof resolvePromptCoordinateFrame;
 *   sanitizeHintLabel: typeof sanitizeHintLabel;
 *   sanitizeOcrTextForPrompt: typeof sanitizeOcrTextForPrompt;
 * }}
 */
function createPromptApi(baseSections) {
  /**
   * @param {PromptOptions} [options]
   * @param {ImageVariant[]} [imageVariants]
   * @returns {string}
   */
  function getOverlayPrompt(options = {}, imageVariants = []) {
    return buildOverlayPrompt(baseSections, options, imageVariants);
  }

  return {
    PROMPT_KO_BBOX_LINES_MULTIVIEW: getOverlayPrompt(),
    buildSystemPrompt,
    buildWorkContextSection,
    getOverlayPrompt,
    readOcrCandidateText,
    readPositiveInteger,
    resolvePromptCoordinateFrame,
    sanitizeHintLabel,
    sanitizeOcrTextForPrompt,
  };
}

module.exports = { createPromptApi };
