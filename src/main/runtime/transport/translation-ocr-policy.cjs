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
  // Strip lexical seeds from unverified detector-only boxes. CUDA legacy is
  // explicitly excluded so its original prompt behavior remains untouched.
  const ocrGeometryOnlyMode =
    hints.length > 0 &&
    Number.isFinite(textEvidenceCount) &&
    textEvidenceCount === 0 &&
    transcriptEvidenceCount === 0 &&
    !options.regionCropMode &&
    !isCudaLegacyOcrMode(options) &&
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
  const textEvidenceCount = Number(result.textEvidenceCount);
  const semanticZeroEvidence =
    !options.regionCropMode &&
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

/** @param {TranslationRequestOptions} options */
function isCudaLegacyOcrMode(options) {
  const quality = String(options.ocrQualityMode ?? "")
    .trim()
    .toLowerCase();
  if (quality === "cuda-legacy-full") return true;
  if (quality === "minimum" || quality === "economy" || quality === "full") {
    return false;
  }
  return (
    String(options.ocrMergeMode ?? "")
      .trim()
      .toLowerCase() === "legacy"
  );
}

module.exports = { createPromptOptions, shouldSkipModelRequest };
