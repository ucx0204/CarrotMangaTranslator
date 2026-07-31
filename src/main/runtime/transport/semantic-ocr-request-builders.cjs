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
  const body = buildChatRequestBody(
    options,
    messages,
    resolveStructuredMaxTokens(options, stage, unitCount),
  );
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
function resolveStructuredMaxTokens(options, stage, unitCount) {
  const configured = Math.max(256, Number(options.maxTokens) || 4096);
  if (stage === "grouping") {
    const requested =
      192 + Math.max(0, unitCount) * SEMANTIC_GROUPING_TOKENS_PER_UNIT;
    return Math.min(configured, Math.max(256, requested));
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
  return Math.min(configured, safeCap, Math.max(768, requested));
}

module.exports = {
  SEMANTIC_REPEAT_LAST_N,
  SEMANTIC_REPEAT_PENALTY,
  SEMANTIC_SEED,
  buildSemanticImageMessages,
  buildSemanticStageRequestBody,
};
