// @ts-check

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
  mergeFixedBlockTranslationResults,
  parseFixedBlockTranslationPartialResponse,
} = require("../semantic-ocr/fixed-block-translation.cjs");
const {
  buildFixedBlockTranslationResponseFormat,
} = require("../semantic-ocr/response-formats.cjs");
const {
  readChatCompletionResult,
  sendChatCompletion,
} = require("./chat-completion.cjs");
const { findAbortError } = require("./model-http-errors.cjs");
const {
  buildSemanticImageMessages,
  buildSemanticStageRequestBody,
} = require("./semantic-ocr-request-builders.cjs");

const MAX_FIXED_BLOCK_REPAIR_ATTEMPTS = 3;

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
  const repaired = await repairInvalidFixedBlockTranslations(
    server,
    options,
    imageVariants,
    plan,
    initialPartial.translations,
    initialPartial.retryBlockIds,
    requestSummary,
    requestStartedAt,
  );
  const translations = repaired.translations;
  const repairResponses = repaired.responses;
  const repairHistory = repaired.history;
  const omittedIds = new Set(repaired.pendingBlockIds);
  const safePlan =
    omittedIds.size === 0
      ? plan
      : {
          ...plan,
          blocks: plan.blocks.filter((block) => !omittedIds.has(block.blockId)),
        };
  const safeTranslations =
    omittedIds.size === 0
      ? translations
      : {
          ...translations,
          items: translations.items.filter(
            (item) => !omittedIds.has(item.blockId),
          ),
        };
  Object.assign(requestSummary, {
    fixedBlockRepairAttempts: repairHistory.length,
    ...(repairHistory.length > 0
      ? { fixedBlockRepairHistory: repairHistory }
      : {}),
    ...(omittedIds.size > 0 ? { fixedBlockOmittedIds: [...omittedIds] } : {}),
  });
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
      buildFixedBlockOverlayPayload(safePlan, safeTranslations),
    ),
  };
}

/**
 * Preserve every accepted translation while regenerating only the immutable
 * ids that were missing, duplicated, malformed, or in the wrong language.
 *
 * @param {ModelServer} server
 * @param {SemanticRequestOptions} options
 * @param {ImageVariant[]} imageVariants
 * @param {ReturnType<typeof buildFixedBlockPlan>} plan
 * @param {{items:Array<{blockId:string;ko:string;textRole?:"ordinary"|"sound"}>;pageContext?:Record<string,unknown>}} initialTranslations
 * @param {string[]} initialPendingBlockIds
 * @param {RequestSummary} requestSummary
 * @param {number} requestStartedAt
 */
async function repairInvalidFixedBlockTranslations(
  server,
  options,
  imageVariants,
  plan,
  initialTranslations,
  initialPendingBlockIds,
  requestSummary,
  requestStartedAt,
) {
  let translations = initialTranslations;
  let pendingBlockIds = initialPendingBlockIds;
  const responses = [];
  const history = [];
  const expectedIds = plan.blocks.map((block) => block.blockId);

  for (
    let repairAttempt = 1;
    pendingBlockIds.length > 0 &&
    repairAttempt <= MAX_FIXED_BLOCK_REPAIR_ATTEMPTS;
    repairAttempt += 1
  ) {
    const repairIds = new Set(pendingBlockIds);
    const repair = buildFixedBlockRepairContext(
      plan,
      options,
      repairIds,
      repairAttempt,
    );
    try {
      const repairPass = await requestFixedBlockPass(
        server,
        repair.options,
        imageVariants,
        repair.plan,
        repair.prompt,
        repair.systemPrompt,
        requestSummary,
        requestStartedAt,
      );
      const partial = parseFixedBlockTranslationPartialResponse(
        repairPass.response.outputText,
        repair.plan,
        repair.options,
      );
      translations = mergeFixedBlockTranslationResults(
        translations,
        partial.translations,
        expectedIds,
      );
      pendingBlockIds = partial.retryBlockIds;
      responses.push(repairPass.response.rawResponse);
      history.push({
        attempt: repairAttempt,
        blockIds: [...repairIds],
        remainingBlockIds: pendingBlockIds,
        forbiddenTokenBias: repairPass.forbiddenTokenBias,
      });
    } catch (error) {
      const abortError = findAbortError(error);
      if (options.abortSignal?.aborted || abortError) {
        throw abortError || error;
      }
      if (!isFixedBlockRepairContractError(error)) throw error;
      history.push({
        attempt: repairAttempt,
        blockIds: [...repairIds],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { translations, pendingBlockIds, responses, history };
}

/**
 * @param {ReturnType<typeof buildFixedBlockPlan>} plan
 * @param {SemanticRequestOptions} options
 * @param {Set<string>} repairIds
 * @param {number} repairAttempt
 */
function buildFixedBlockRepairContext(plan, options, repairIds, repairAttempt) {
  const repairPlan = {
    ...plan,
    blocks: plan.blocks.filter((block) => repairIds.has(block.blockId)),
  };
  const repairOptions = {
    ...options,
    collectPageContext: false,
    translationAttempt:
      Math.max(1, Number(options.translationAttempt) || 1) + repairAttempt,
  };
  return {
    plan: repairPlan,
    options: repairOptions,
    prompt: buildFixedBlockTranslationPrompt(repairPlan, repairOptions),
    systemPrompt: buildFixedBlockTranslationSystemPrompt(repairOptions),
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

/** @param {unknown} error */
function isFixedBlockRepairContractError(error) {
  if (!error || typeof error !== "object") return false;
  const code = String(/** @type {{code?:unknown}} */ (error).code ?? "");
  return (
    code === "semantic-ocr-json-invalid" ||
    code.startsWith("fixed-block-translation-")
  );
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
