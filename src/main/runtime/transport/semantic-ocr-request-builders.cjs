// @ts-check

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & {
 *   maxTokens?:unknown;
 *   ctx?:unknown;
 *   temperature?:unknown;
 *   translationAttempt?:unknown;
 *   collectPageContext?:unknown;
 *   workContextBudget?:{
 *     effective?:{outputHeadroomTokens?:unknown};
 *   };
 *   [key:string]:unknown;
 * }} SemanticRequestOptions
 * @typedef {{role:string;dataUrl?:string;[key:string]:unknown}} ImageVariant
 * @typedef {Record<string, unknown>} RequestSummary
 */

const { describeImageVariant } = require("../simple-page-request-builders.cjs");
const { buildChatRequestBody } = require("./request-bodies.cjs");

const SEMANTIC_REPEAT_LAST_N = 256;
const SEMANTIC_REPEAT_PENALTY = 1.08;
const SEMANTIC_SEED = 424242;
const SEMANTIC_GROUPING_TOKENS_PER_UNIT = 64;
const SEMANTIC_TRANSLATION_BASE_TOKENS = 4096;
const SEMANTIC_TRANSLATION_TOKENS_PER_UNIT = 1024;
const SEMANTIC_PAGE_CONTEXT_TOKENS = 8192;
const SEMANTIC_TRANSLATION_MAX_RETRY_SCALE = 4;
const SEMANTIC_TRANSLATION_INPUT_RESERVE_TOKENS = 6400;
const WORK_CONTEXT_TRUNCATION_MESSAGE =
  "모델 응답이 작품 정보 예산 한도에서 잘렸습니다. 설정 > LLM > 작품 정보 예산을 늘려 주세요.";
const CONTEXT_LENGTH_TRUNCATION_MESSAGE =
  "모델 응답이 컨텍스트 길이 한도에서 잘렸습니다. 설정 > LLM > 컨텍스트 길이를 늘려 주세요. VRAM 사용량이 늘 수 있습니다.";
const STRUCTURED_BUDGET_TRUNCATION_MESSAGE =
  "모델 응답이 앱 내부 구조화 출력 한도에서 잘렸습니다. 사용자 설정 부족으로 단정할 수 없어 진단 가능한 일반 오류로 처리합니다.";
const MAX_OUTPUT_TRUNCATION_MESSAGE =
  "모델 응답이 최대 출력 토큰 한도에서 잘렸습니다. 설정 > LLM > 최대 출력 토큰을 늘려 주세요.";

/** @type {Record<string, [string, string?]>} */
const OUTPUT_TRUNCATION_DETAILS = {
  "work-context-budget": [
    WORK_CONTEXT_TRUNCATION_MESSAGE,
    "increase-work-context-budget",
  ],
  "context-length": [
    CONTEXT_LENGTH_TRUNCATION_MESSAGE,
    "increase-context-length",
  ],
  "structured-request-budget": [STRUCTURED_BUDGET_TRUNCATION_MESSAGE],
  default: [MAX_OUTPUT_TRUNCATION_MESSAGE, "increase-max-output-tokens"],
};

/** @param {RequestSummary} requestSummary */
function resolveOutputTruncationDetail(requestSummary) {
  const details =
    OUTPUT_TRUNCATION_DETAILS[
      String(requestSummary.responseTokenLimitSource)
    ] ?? OUTPUT_TRUNCATION_DETAILS.default;
  const [message, failureGuidance] = details;
  return failureGuidance ? { message, failureGuidance } : { message };
}

/**
 * @param {SemanticRequestOptions} options
 * @param {ImageVariant[]} variants
 * @param {string} promptText
 * @param {string} systemPrompt
 */
function buildSemanticImageMessages(
  options,
  variants,
  promptText,
  systemPrompt,
) {
  const imageParts = variants.flatMap((variant, index) => [
    { type: "image_url", image_url: { url: variant.dataUrl } },
    { type: "text", text: describeImageVariant(variant, index, options) },
  ]);
  return [
    { role: "system", content: [{ type: "text", text: systemPrompt }] },
    {
      role: "user",
      content: [...imageParts, { type: "text", text: promptText }],
    },
  ];
}

/**
 * @param {SemanticRequestOptions} options
 * @param {Array<Record<string,unknown>>} messages
 * @param {Record<string,unknown>} responseFormat
 * @param {"grouping"|"translation"} stage
 * @param {number} unitCount
 */
function buildSemanticStageRequestBody(
  options,
  messages,
  responseFormat,
  stage,
  unitCount,
) {
  const tokenBudget = resolveStructuredTokenBudget(options, stage, unitCount);
  const body = buildChatRequestBody(options, messages, tokenBudget.maxTokens);
  return Object.assign(body, {
    response_format: responseFormat,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_format: "none",
    reasoning_budget: 0,
    enable_thinking: false,
    temperature:
      stage === "grouping"
        ? 0
        : Math.max(0, Math.min(0.2, Number(options.temperature) || 0.2)),
    top_p: 0.95,
    top_k: 64,
    seed: SEMANTIC_SEED,
    cache_prompt: false,
    // Fixed sampling contract for stable small-model output.
    repeat_penalty: SEMANTIC_REPEAT_PENALTY,
    repeat_last_n: SEMANTIC_REPEAT_LAST_N,
  });
}

/**
 * @param {SemanticRequestOptions} options
 * @param {"grouping"|"translation"} stage
 * @param {number} unitCount
 */
function resolveStructuredTokenBudget(options, stage, unitCount) {
  const configured = Math.max(256, Number(options.maxTokens) || 4096);
  if (stage === "grouping") {
    const requested =
      192 + Math.max(0, unitCount) * SEMANTIC_GROUPING_TOKENS_PER_UNIT;
    const requestedCap = Math.max(256, requested);
    return {
      maxTokens: Math.min(configured, requestedCap),
      source:
        configured <= requestedCap
          ? "max-output-tokens"
          : "structured-request-budget",
    };
  }

  const attempt = Math.max(
    1,
    Math.trunc(Number(options.translationAttempt) || 1),
  );
  const retryScale = Math.min(
    SEMANTIC_TRANSLATION_MAX_RETRY_SCALE,
    2 ** Math.min(2, attempt - 1),
  );
  const requested =
    (SEMANTIC_TRANSLATION_BASE_TOKENS +
      Math.max(1, unitCount) * SEMANTIC_TRANSLATION_TOKENS_PER_UNIT +
      (options.collectPageContext ? SEMANTIC_PAGE_CONTEXT_TOKENS : 0)) *
    retryScale;
  const budgetHeadroom = Number(
    options.workContextBudget?.effective?.outputHeadroomTokens,
  );
  const contextTokens = Number(options.ctx);
  const contextHeadroom =
    Number.isFinite(contextTokens) && contextTokens > 0
      ? contextTokens - SEMANTIC_TRANSLATION_INPUT_RESERVE_TOKENS
      : Number.NaN;
  const outputHeadroom = Number.isFinite(budgetHeadroom)
    ? budgetHeadroom
    : contextHeadroom;
  const safeCap = Number.isFinite(outputHeadroom)
    ? Math.max(256, Math.trunc(outputHeadroom))
    : configured;
  const requestedCap = Math.max(768, requested);
  const maxTokens = Math.min(configured, safeCap, requestedCap);
  return {
    maxTokens,
    source: resolveTranslationTokenLimitSource(
      options,
      configured,
      safeCap,
      requestedCap,
    ),
  };
}

/**
 * @param {SemanticRequestOptions} options
 * @param {number} configured
 * @param {number} safeCap
 * @param {number} requestedCap
 */
function resolveTranslationTokenLimitSource(
  options,
  configured,
  safeCap,
  requestedCap,
) {
  if (configured <= safeCap && configured <= requestedCap) {
    return "max-output-tokens";
  }
  if (safeCap < configured && safeCap <= requestedCap) {
    return options.modelProvider === "gemma"
      ? "context-length"
      : "work-context-budget";
  }
  return "structured-request-budget";
}

module.exports = {
  SEMANTIC_REPEAT_LAST_N,
  SEMANTIC_REPEAT_PENALTY,
  SEMANTIC_SEED,
  buildSemanticImageMessages,
  buildSemanticStageRequestBody,
  resolveOutputTruncationDetail,
  resolveStructuredTokenBudget,
};
