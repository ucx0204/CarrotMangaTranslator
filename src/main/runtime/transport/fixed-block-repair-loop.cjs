// @ts-check

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { maxTokens?:unknown;abortSignal?:AbortSignal|null;collectPageContext?:unknown;ocrBboxHints:Record<string,unknown>[];[key:string]:unknown }} SemanticRequestOptions
 * @typedef {{baseUrl:string;[key:string]:unknown}} ModelServer
 * @typedef {{role:string;path:string;[key:string]:unknown}} ImageVariant
 * @typedef {{blockId:string;ko:string;textRole?:"ordinary"|"sound";layoutIntent?:"horizontal"|"vertical";fontRole?:string;fontRoleConfidence?:number;visualClusterId?:string}} FixedBlockTranslation
 * @typedef {{items:FixedBlockTranslation[];pageContext?:Record<string,unknown>}} FixedBlockTranslationResult
 * @typedef {{translations:FixedBlockTranslationResult;retryBlockIds:string[];retryReasons:Record<string,string[]>;horizontalFallbackTranslations?:FixedBlockTranslationResult;fontIntentFallbackTranslations?:FixedBlockTranslationResult;targetTypographyFallbackTranslations?:FixedBlockTranslationResult;sourceScriptFallbackTranslations?:FixedBlockTranslationResult;readableTextFallbackTranslations?:FixedBlockTranslationResult}} FixedBlockPartialResult
 * @typedef {{response:{outputText:string;rawResponse:unknown};forbiddenTokenBias:unknown}} FixedBlockPassResult
 * @typedef {(server:ModelServer,options:SemanticRequestOptions,imageVariants:ImageVariant[],plan:FixedBlockPlan,promptText:string,systemPrompt:string,requestSummary:Record<string,unknown>,requestStartedAt:number)=>Promise<FixedBlockPassResult>} FixedBlockPassRequester
 * @typedef {ReturnType<typeof _buildFixedBlockPlan>} FixedBlockPlan
 * @typedef {{translations:FixedBlockTranslationResult;pendingBlockIds:string[];retryReasons:Record<string,string[]>;responses:unknown[];history:unknown[]}} FixedBlockRepairState
 * @typedef {{horizontal:Map<string,FixedBlockTranslation>;fontIntent:Map<string,FixedBlockTranslation>;targetTypography:Map<string,FixedBlockTranslation>;sourceScript:Map<string,FixedBlockTranslation>;readableText:Map<string,FixedBlockTranslation>}} FixedBlockFallbacks
 */

const {
  buildFixedBlockPlan: _buildFixedBlockPlan,
  buildFixedBlockTranslationPrompt,
  buildFixedBlockTranslationSystemPrompt,
  mergeFixedBlockTranslationResults,
  parseFixedBlockTranslationPartialResponse,
} = require("../semantic-ocr/fixed-block-translation.cjs");
const {
  completeFixedBlockFallbacks,
} = require("../semantic-ocr/fixed-block-repair-fallback.cjs");
const { findAbortError } = require("./model-http-errors.cjs");

const MAX_FIXED_BLOCK_REPAIR_ATTEMPTS = 3;

/**
 * Preserve accepted translations while retrying only immutable IDs that were
 * missing, duplicated, malformed, or in the wrong language.
 *
 * @param {{server:ModelServer;options:SemanticRequestOptions;imageVariants:ImageVariant[];plan:FixedBlockPlan;initialPartial:FixedBlockPartialResult;requestSummary:Record<string,unknown>;requestStartedAt:number;requestPass:FixedBlockPassRequester}} context
 */
async function repairInvalidFixedBlockTranslations(context) {
  const expectedIds = context.plan.blocks.map((block) => block.blockId);
  const fallbacks = createFallbackIndexes(context.initialPartial);
  const state = await runFixedBlockRepairAttempts(
    context,
    expectedIds,
    fallbacks,
  );
  return completeFixedBlockFallbacks(state, fallbacks, context.plan.blocks);
}

/**
 * @param {{server:ModelServer;options:SemanticRequestOptions;imageVariants:ImageVariant[];plan:FixedBlockPlan;initialPartial:FixedBlockPartialResult;requestSummary:Record<string,unknown>;requestStartedAt:number;requestPass:FixedBlockPassRequester}} context
 * @param {string[]} expectedIds
 * @param {FixedBlockFallbacks} fallbacks
 * @returns {Promise<FixedBlockRepairState>}
 */
async function runFixedBlockRepairAttempts(context, expectedIds, fallbacks) {
  const state = createRepairState(context.initialPartial);
  for (
    let attempt = 1;
    state.pendingBlockIds.length > 0 &&
    attempt <= MAX_FIXED_BLOCK_REPAIR_ATTEMPTS;
    attempt += 1
  ) {
    const repairIds = new Set(state.pendingBlockIds);
    const repair = buildFixedBlockRepairContext(
      context.plan,
      context.options,
      repairIds,
      attempt,
    );
    try {
      const pass = await context.requestPass(
        context.server,
        repair.options,
        context.imageVariants,
        repair.plan,
        repair.prompt,
        repair.systemPrompt,
        context.requestSummary,
        context.requestStartedAt,
      );
      applySuccessfulRepair(
        state,
        pass,
        repair.plan,
        repair.options,
        repairIds,
        attempt,
        expectedIds,
        fallbacks,
      );
    } catch (error) {
      applyFailedRepair(state, error, context.options, repairIds, attempt);
    }
  }
  return state;
}

/**
 * @param {FixedBlockRepairState} state
 * @param {FixedBlockPassResult} pass
 * @param {FixedBlockPlan} plan
 * @param {SemanticRequestOptions} options
 * @param {Set<string>} repairIds
 * @param {number} attempt
 * @param {string[]} expectedIds
 * @param {FixedBlockFallbacks} fallbacks
 */
function applySuccessfulRepair(
  state,
  pass,
  plan,
  options,
  repairIds,
  attempt,
  expectedIds,
  fallbacks,
) {
  const partial = parseFixedBlockTranslationPartialResponse(
    pass.response.outputText,
    plan,
    options,
  );
  state.translations = mergeFixedBlockTranslationResults(
    state.translations,
    partial.translations,
    expectedIds,
  );
  preserveFirstFallbackTranslations(
    fallbacks.horizontal,
    partial.horizontalFallbackTranslations,
  );
  preserveFirstFallbackTranslations(
    fallbacks.fontIntent,
    partial.fontIntentFallbackTranslations,
  );
  preserveFirstFallbackTranslations(
    fallbacks.targetTypography,
    partial.targetTypographyFallbackTranslations,
  );
  replaceFallbackTranslations(
    fallbacks.sourceScript,
    partial.sourceScriptFallbackTranslations,
  );
  replaceFallbackTranslations(
    fallbacks.readableText,
    partial.readableTextFallbackTranslations,
  );
  state.pendingBlockIds = partial.retryBlockIds;
  state.retryReasons = partial.retryReasons;
  state.responses.push(pass.response.rawResponse);
  state.history.push({
    attempt,
    blockIds: [...repairIds],
    remainingBlockIds: state.pendingBlockIds,
    ...(state.pendingBlockIds.length > 0
      ? { rejectionReasons: state.retryReasons }
      : {}),
    forbiddenTokenBias: pass.forbiddenTokenBias,
  });
}

/**
 * @param {FixedBlockRepairState} state
 * @param {unknown} error
 * @param {SemanticRequestOptions} options
 * @param {Set<string>} repairIds
 * @param {number} attempt
 */
function applyFailedRepair(state, error, options, repairIds, attempt) {
  const abortError = findAbortError(error);
  if (options.abortSignal?.aborted || abortError) {
    throw abortError || error;
  }
  if (!isFixedBlockRepairContractError(error)) throw error;
  const code = readRepairContractErrorCode(error);
  state.retryReasons = Object.fromEntries(
    [...repairIds].map((blockId) => [blockId, [code]]),
  );
  state.history.push({
    attempt,
    blockIds: [...repairIds],
    error: error instanceof Error ? error.message : String(error),
  });
}

/** @param {FixedBlockPartialResult} initial */
function createRepairState(initial) {
  return {
    translations: initial.translations,
    pendingBlockIds: initial.retryBlockIds,
    retryReasons: initial.retryReasons,
    responses: [],
    history: [],
  };
}

/** @param {FixedBlockPartialResult} initial @returns {FixedBlockFallbacks} */
function createFallbackIndexes(initial) {
  return {
    horizontal: indexFallbackTranslations(
      initial.horizontalFallbackTranslations,
    ),
    fontIntent: indexFallbackTranslations(
      initial.fontIntentFallbackTranslations,
    ),
    targetTypography: indexFallbackTranslations(
      initial.targetTypographyFallbackTranslations,
    ),
    sourceScript: indexFallbackTranslations(
      initial.sourceScriptFallbackTranslations,
    ),
    readableText: indexFallbackTranslations(
      initial.readableTextFallbackTranslations,
    ),
  };
}

/** @param {FixedBlockTranslationResult|undefined} translations */
function indexFallbackTranslations(translations) {
  return new Map(
    (translations?.items ?? []).map((item) => [item.blockId, item]),
  );
}

/**
 * Keep the first otherwise-valid text so advisory retries cannot rewrite an
 * already correct translation.
 * @param {Map<string,FixedBlockTranslation>} fallbackById
 * @param {FixedBlockTranslationResult|undefined} translations
 */
function preserveFirstFallbackTranslations(fallbackById, translations) {
  for (const item of translations?.items ?? []) {
    if (!fallbackById.has(item.blockId)) fallbackById.set(item.blockId, item);
  }
}

/**
 * A focused repair is more useful than the earlier malformed value even when
 * it still needs review, so retain the latest readable text candidate.
 * @param {Map<string,FixedBlockTranslation>} fallbackById
 * @param {FixedBlockTranslationResult|undefined} translations
 */
function replaceFallbackTranslations(fallbackById, translations) {
  for (const item of translations?.items ?? []) {
    fallbackById.set(item.blockId, item);
  }
}

/**
 * @param {FixedBlockPlan} plan
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

/** @param {Record<string,unknown>} summary @param {ReturnType<typeof completeFixedBlockFallbacks>} repaired */
function recordFixedBlockRepairSummary(summary, repaired) {
  Object.assign(summary, {
    fixedBlockRepairAttempts: repaired.history.length,
    ...asNonEmptyValue("fixedBlockRepairHistory", repaired.history),
    ...asNonEmptyValue(
      "fixedBlockHorizontalFallbackIds",
      repaired.horizontalFallbackBlockIds,
    ),
    ...asNonEmptyValue(
      "fixedBlockFontIntentFallbackIds",
      repaired.fontIntentFallbackBlockIds,
    ),
    ...asNonEmptyValue(
      "fixedBlockTargetTypographyFallbackIds",
      repaired.targetTypographyFallbackBlockIds,
    ),
    ...asNonEmptyValue(
      "fixedBlockSourceScriptFallbackIds",
      repaired.sourceScriptFallbackBlockIds,
    ),
    ...asNonEmptyValue(
      "fixedBlockReadableTextFallbackIds",
      repaired.readableTextFallbackBlockIds,
    ),
    ...asNonEmptyValue(
      "fixedBlockSourceTextFallbackIds",
      repaired.sourceTextFallbackBlockIds,
    ),
    ...asNonEmptyValue(
      "fixedBlockNeedsReviewIds",
      repaired.needsReviewBlockIds,
    ),
    ...(repaired.needsReviewBlockIds.length > 0
      ? {
          fixedBlockNeedsReviewReasons: pickRetryReasons(
            repaired.retryReasons,
            repaired.needsReviewBlockIds,
          ),
        }
      : {}),
    ...(repaired.pendingBlockIds.length > 0
      ? {
          fixedBlockUnresolvedIds: repaired.pendingBlockIds,
          fixedBlockUnresolvedReasons: pickRetryReasons(
            repaired.retryReasons,
            repaired.pendingBlockIds,
          ),
        }
      : {}),
  });
}

/** @param {string} key @param {unknown[]} values */
function asNonEmptyValue(key, values) {
  return values.length > 0 ? { [key]: values } : {};
}

/** @param {unknown} error */
function isFixedBlockRepairContractError(error) {
  if (!error || typeof error !== "object") return false;
  const code = String(/** @type {{code?:unknown}} */ (error).code ?? "");
  return (
    code === "semantic-ocr-json-invalid" ||
    code.startsWith("fixed-block-translation")
  );
}

/** @param {unknown} error */
function readRepairContractErrorCode(error) {
  if (!error || typeof error !== "object") return "unknown";
  const code = String(/** @type {{code?:unknown}} */ (error).code ?? "");
  return code || "unknown";
}

/** @param {Record<string,string[]>} reasons @param {string[]} blockIds */
function pickRetryReasons(reasons, blockIds) {
  return Object.fromEntries(
    blockIds.map((blockId) => [blockId, reasons[blockId] ?? ["unknown"]]),
  );
}

module.exports = {
  recordFixedBlockRepairSummary,
  repairInvalidFixedBlockTranslations,
};
