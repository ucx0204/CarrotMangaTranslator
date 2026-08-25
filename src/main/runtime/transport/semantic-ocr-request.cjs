// @ts-check

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { maxTokens?: unknown; abortSignal?: AbortSignal | null; collectPageContext?: unknown; ocrBboxHints: Record<string, unknown>[]; [key: string]: unknown }} SemanticRequestOptions
 * @typedef {{ baseUrl: string; [key: string]: unknown }} ModelServer
 * @typedef {{ role: string; path: string; dataUrl?: string; width?: unknown; height?: unknown; originalWidth?: unknown; originalHeight?: unknown; [key: string]: unknown }} ImageVariant
 * @typedef {Record<string, unknown>} RequestSummary
 * @typedef {{ hints: unknown[]; noTextDetected: boolean; textEvidenceCount: unknown; diagnostics: unknown[] }} OcrBboxResult
 * @typedef {{blockId:string;ko:string;textRole?:"ordinary"|"sound";layoutIntent?:"horizontal"|"vertical";fontRole?:string;fontRoleConfidence?:number;visualClusterId?:string}} FixedBlockTranslation
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
  parseFixedBlockTranslationPartialResponse,
} = require("../semantic-ocr/fixed-block-translation.cjs");
const {
  buildFixedBlockTranslationResponseFormat,
} = require("../semantic-ocr/response-formats.cjs");
const {
  readChatCompletionResult,
  sendChatCompletion,
} = require("./chat-completion.cjs");
const {
  assertFixedBlockRepairComplete,
  recordFixedBlockRepairSummary,
  repairInvalidFixedBlockTranslations,
} = require("./fixed-block-repair-loop.cjs");
const {
  buildSemanticImageMessages,
  buildSemanticStageRequestBody,
  resolveStructuredTokenBudget,
} = require("./semantic-ocr-request-builders.cjs");

/**
 * Translate code-owned OCR groups. The model receives the page for context,
 * but its response can contain only one visual text role and target-language
 * string per opaque block id.
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
  const context = await prepareFixedBlockRequest(
    server,
    options,
    ocrBboxResult,
  );
  const { imageVariants, plan, promptText, requestSummary, systemPrompt } =
    context;
  if (plan.blocks.length === 0) {
    return buildNoLexicalCandidatesResult(requestSummary);
  }
  const initialPass = await requestFixedBlockPass(
    server,
    options,
    imageVariants,
    plan,
    promptText,
    systemPrompt,
    requestSummary,
    requestStartedAt,
  );
  requestSummary.fixedBlockTranslationForbiddenTokenBias =
    initialPass.forbiddenTokenBias;
  requestSummary.localForbiddenTokenBias =
    requestSummary.fixedBlockTranslationForbiddenTokenBias;
  const initialPartial = parseFixedBlockTranslationPartialResponse(
    initialPass.response.outputText,
    plan,
    options,
  );
  return completeFixedBlockTranslation(
    server,
    options,
    context,
    initialPass,
    initialPartial,
    requestStartedAt,
  );
}

/**
 * @param {ModelServer} server
 * @param {SemanticRequestOptions} options
 * @param {OcrBboxResult} ocrBboxResult
 */
async function prepareFixedBlockRequest(server, options, ocrBboxResult) {
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
    fixedBlockDirectionVoterCandidateIds: plan.blocks.map(
      (block) => block.directionVoterCandidateIds,
    ),
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
  return { imageVariants, plan, promptText, requestSummary, systemPrompt };
}

/** @param {RequestSummary} requestSummary */
function buildNoLexicalCandidatesResult(requestSummary) {
  return {
    requestBody: requestSummary,
    rawResponse: {
      skipped: true,
      reason: "fixed-block-no-lexical-candidates",
    },
    outputText: '{"items":[]}',
  };
}

/**
 * @param {ModelServer} server
 * @param {SemanticRequestOptions} options
 * @param {Awaited<ReturnType<typeof prepareFixedBlockRequest>>} context
 * @param {Awaited<ReturnType<typeof requestFixedBlockPass>>} initialPass
 * @param {ReturnType<typeof parseFixedBlockTranslationPartialResponse>} initialPartial
 * @param {number} requestStartedAt
 */
async function completeFixedBlockTranslation(
  server,
  options,
  context,
  initialPass,
  initialPartial,
  requestStartedAt,
) {
  const { imageVariants, plan, requestSummary } = context;
  const repaired = await repairInvalidFixedBlockTranslations({
    server,
    options,
    imageVariants,
    plan,
    initialPartial,
    requestSummary,
    requestStartedAt,
    requestPass: requestFixedBlockPass,
  });
  const translations = repaired.translations;
  const repairResponses = repaired.responses;
  recordFixedBlockRepairSummary(requestSummary, repaired);
  assertFixedBlockRepairComplete(repaired);
  return {
    requestBody: requestSummary,
    rawResponse:
      repairResponses.length > 0
        ? {
            initial: initialPass.response.rawResponse,
            repairs: repairResponses,
          }
        : initialPass.response.rawResponse,
    outputText: JSON.stringify(
      buildFixedBlockOverlayPayload(plan, translations),
    ),
  };
}

/**
 * @param {ModelServer} server
 * @param {SemanticRequestOptions} options
 * @param {ImageVariant[]} imageVariants
 * @param {ReturnType<typeof buildFixedBlockPlan>} plan
 * @param {string} promptText
 * @param {string} systemPrompt
 * @param {RequestSummary} requestSummary
 * @param {number} requestStartedAt
 */
async function requestFixedBlockPass(
  server,
  options,
  imageVariants,
  plan,
  promptText,
  systemPrompt,
  requestSummary,
  requestStartedAt,
) {
  const blockIds = plan.blocks.map((block) => block.blockId);
  const tokenBudget = resolveStructuredTokenBudget(
    options,
    "translation",
    blockIds.length,
  );
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
  Object.assign(requestSummary, {
    responseMaxTokens: tokenBudget.maxTokens,
    responseTokenLimitSource: tokenBudget.source,
  });
  const forbiddenTokenBias = await applyLocalForbiddenTokenBias(
    server,
    options,
    requestBody,
  );
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
  return { response, forbiddenTokenBias };
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
