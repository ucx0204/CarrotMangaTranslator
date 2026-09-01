// @ts-check

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { ocrBboxHints?: unknown; [key:string]: unknown }} TranslationRequestOptions
 * @typedef {{ hints: unknown[]; noTextDetected: boolean; textEvidenceCount: unknown; diagnostics: unknown[] }} OcrBboxResult
 * @typedef {TranslationRequestOptions & { ocrBboxHints: Record<string, unknown>[] }} PromptRequestOptions
 */

const {
  allowOcrNoTextDetectedSkip,
  isJapaneseLanguageCode,
} = require("../simple-page-language-profile.cjs");
const { readOcrCandidateText } = require("../prompts/ocr-text.cjs");
const { isCommonSemanticOcrMode } = require("../semantic-ocr/candidates.cjs");

/**
 * @param {TranslationRequestOptions} options
 * @param {OcrBboxResult} result
 * @returns {PromptRequestOptions}
 */
function createPromptOptions(options, result) {
  const hints = Array.isArray(result.hints) ? result.hints : [];
  const textEvidenceCount = Number(result.textEvidenceCount);
  const transcriptEvidenceCount = hints.filter((hint) =>
    /[\p{L}\p{N}]/u.test(readOcrCandidateText(hint)),
  ).length;
  // Strip lexical seeds from unverified detector-only boxes.
  const ocrGeometryOnlyMode =
    hints.length > 0 &&
    Number.isFinite(textEvidenceCount) &&
    textEvidenceCount === 0 &&
    transcriptEvidenceCount === 0 &&
    !options.regionCropMode &&
    isJapaneseLanguageCode(options.sourceLanguage);
  return /** @type {PromptRequestOptions} */ ({
    ...options,
    ocrBboxHints: /** @type {Record<string, unknown>[]} */ (hints),
    ocrTextEvidenceCount: Number.isFinite(textEvidenceCount)
      ? textEvidenceCount
      : undefined,
    ocrTranscriptEvidenceCount: transcriptEvidenceCount,
    ocrGeometryOnlyMode: ocrGeometryOnlyMode || undefined,
    ...(ocrGeometryOnlyMode
      ? { previousBlocksForPrompt: [], workContext: undefined }
      : {}),
  });
}

/** @param {OcrBboxResult} result @param {TranslationRequestOptions} options */
function shouldSkipModelRequest(result, options) {
  // A user-selected crop and a detector-owned SFX crop are themselves strong
  // visual evidence. OCR may fail on stylized or tiny glyphs, so these paths
  // must always let the vision model inspect the supplied pixels.
  if (options.regionCropMode || options.soundEffectTranslationMode) {
    return false;
  }
  const textEvidenceCount = Number(result.textEvidenceCount);
  const semanticZeroEvidence =
    isCommonSemanticOcrMode(options) &&
    isJapaneseLanguageCode(options.sourceLanguage) &&
    Number.isFinite(textEvidenceCount) &&
    textEvidenceCount === 0 &&
    Number(options.ocrTranscriptEvidenceCount) === 0;
  return (
    semanticZeroEvidence ||
    (!options.collectPageContext &&
      result.noTextDetected &&
      (!Array.isArray(result.hints) || result.hints.length === 0) &&
      allowOcrNoTextDetectedSkip(options))
  );
}

module.exports = { createPromptOptions, shouldSkipModelRequest };
