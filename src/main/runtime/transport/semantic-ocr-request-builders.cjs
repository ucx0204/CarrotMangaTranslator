// @ts-check

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & {maxTokens?:unknown;temperature?:unknown;[key:string]:unknown}} SemanticRequestOptions
 * @typedef {{role:string;dataUrl?:string;[key:string]:unknown}} ImageVariant
 */

const { describeImageVariant } = require("../simple-page-request-builders.cjs");
const { buildChatRequestBody } = require("./request-bodies.cjs");

const SEMANTIC_REPEAT_LAST_N = 256;
const SEMANTIC_REPEAT_PENALTY = 1.08;
const SEMANTIC_SEED = 424242;
const SEMANTIC_GROUPING_TOKENS_PER_UNIT = 64;

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
  const requested =
    stage === "grouping"
      ? 192 + Math.max(0, unitCount) * SEMANTIC_GROUPING_TOKENS_PER_UNIT
      : 384 + Math.max(1, unitCount) * 320;
  return Math.min(
    configured,
    Math.max(stage === "grouping" ? 256 : 768, requested),
  );
}

module.exports = {
  SEMANTIC_REPEAT_LAST_N,
  SEMANTIC_REPEAT_PENALTY,
  SEMANTIC_SEED,
  buildSemanticImageMessages,
  buildSemanticStageRequestBody,
};
