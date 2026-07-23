// @ts-check
/* eslint-disable max-lines-per-function -- keep the single accepted fixed-translation request path linear */

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { maxTokens?: unknown; abortSignal?: AbortSignal | null; collectPageContext?: unknown; ocrBboxHints: Record<string, unknown>[]; [key: string]: unknown }} SemanticRequestOptions
 * @typedef {{ baseUrl: string; [key: string]: unknown }} ModelServer
 * @typedef {{ role: string; path: string; dataUrl?: string; width?: unknown; height?: unknown; originalWidth?: unknown; originalHeight?: unknown; [key: string]: unknown }} ImageVariant
 * @typedef {Record<string, unknown>} RequestSummary
 * @typedef {{ hints: unknown[]; noTextDetected: boolean; textEvidenceCount: unknown; diagnostics: unknown[] }} OcrBboxResult
 */

const { prepareImageVariants } = require("../simple-page-image-variants.cjs");
const {
  applyLocalForbiddenTokenBias,
} = require("../simple-page-logit-bias.cjs");
const { buildRequestSummary } = require("../simple-page-request-summary.cjs");
const {
  FIXED_BLOCK_TRANSLATION_VERSION,
  buildFixedBlockOverlayPayload,
  buildFixedBlockPlan,
  buildFixedBlockTranslationPrompt,
  buildFixedBlockTranslationSystemPrompt,
  parseFixedBlockTranslationResponse,
} = require("../semantic-ocr/fixed-block-translation.cjs");
const {
  buildFixedBlockTranslationResponseFormat,
} = require("../semantic-ocr/response-formats.cjs");
const {
  readChatCompletionResult,
  sendChatCompletion,
} = require("./chat-completion.cjs");
const {
  buildSemanticImageMessages,
  buildSemanticStageRequestBody,
} = require("./semantic-ocr-request-builders.cjs");

/**
 * Translate code-owned OCR groups. The model receives the page for context,
 * but its response can contain only one Korean string per opaque block id.
 *
 * @param {ModelServer} server
 * @param {SemanticRequestOptions} options
 * @param {OcrBboxResult} ocrBboxResult
 * @param {number} requestStartedAt
 */
async function requestFixedBlockTranslation(
  server,
  options,
  ocrBboxResult,
  requestStartedAt,
) {
  const prepared = await prepareImageVariants(
    /** @type {Parameters<typeof prepareImageVariants>[0]} */ (options),
  );
  const imageVariants = /** @type {ImageVariant[]} */ (prepared.imageVariants);
  const plan = buildFixedBlockPlan(options, imageVariants);
  const promptText = buildFixedBlockTranslationPrompt(plan, options);
  const systemPrompt = buildFixedBlockTranslationSystemPrompt(options);
  const requestSummary = buildRequestSummary(
    server,
    options,
    imageVariants,
    promptText,
    systemPrompt,
  );
  Object.assign(requestSummary, {
    fixedBlockTranslationVersion: FIXED_BLOCK_TRANSLATION_VERSION,
    fixedBlockCount: plan.blocks.length,
    fixedBlockIds: plan.blocks.map((block) => block.blockId),
    fixedBlockCandidateIds: plan.blocks.map((block) => block.candidateIds),
    promptText,
    systemPromptText: systemPrompt,
    noTextDetected: plan.blocks.length === 0,
    ocrTextEvidenceCount: ocrBboxResult.textEvidenceCount,
    ocrTranscriptEvidenceCount: options.ocrTranscriptEvidenceCount,
  });
  addDiagnostics(
    requestSummary,
    "imageVariantDiagnostics",
    prepared.diagnostics,
  );
  addDiagnostics(
    requestSummary,
    "ocrBboxDiagnostics",
    ocrBboxResult.diagnostics,
  );

  if (plan.blocks.length === 0) {
    return {
      requestBody: requestSummary,
      rawResponse: {
        skipped: true,
        reason: "fixed-block-no-lexical-candidates",
      },
      outputText: '{"items":[]}',
    };
  }

  const blockIds = plan.blocks.map((block) => block.blockId);
  const requestBody = buildSemanticStageRequestBody(
    options,
    buildSemanticImageMessages(
      options,
      imageVariants,
      promptText,
      systemPrompt,
    ),
    buildFixedBlockTranslationResponseFormat(blockIds, options),
    "translation",
    blockIds.length,
  );
  requestSummary.fixedBlockTranslationForbiddenTokenBias =
    await applyLocalForbiddenTokenBias(server, options, requestBody);
  requestSummary.localForbiddenTokenBias =
    requestSummary.fixedBlockTranslationForbiddenTokenBias;
  const rawResponse = await sendChatCompletion(
    server,
    options,
    requestBody,
    requestSummary,
    undefined,
  );
  const response = await readChatCompletionResult(
    rawResponse,
    options,
    requestSummary,
    requestStartedAt,
  );
  const translations = parseFixedBlockTranslationResponse(
    response.outputText,
    plan,
    options,
  );
  return {
    requestBody: requestSummary,
    rawResponse: response.rawResponse,
    outputText: JSON.stringify(
      buildFixedBlockOverlayPayload(plan, translations),
    ),
  };
}

/**
 * @param {RequestSummary} summary
 * @param {string} key
 * @param {unknown[]} diagnostics
 */
function addDiagnostics(summary, key, diagnostics) {
  if (diagnostics.length > 0) summary[key] = diagnostics;
}

module.exports = { requestFixedBlockTranslation };
