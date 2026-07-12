// @ts-check
const { attachOcrGroupingHints } = require("./ocr/hint-grouping.cjs");
const {
  extractJsonText,
  normalizeOcrBboxHintPayload,
} = require("./ocr/hint-normalization.cjs");

module.exports = {
  attachOcrGroupingHints,
  extractJsonText,
  normalizeOcrBboxHintPayload,
};
