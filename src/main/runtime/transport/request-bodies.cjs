// @ts-check
/**
 * @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { maxTokens?: unknown; [key: string]: unknown }} TranslationRequestOptions
 * @typedef {{ role?: string; content?: unknown; [key: string]: unknown }} ChatMessage
 * @typedef {{ role: string; path: string; mime?: string; width?: unknown; height?: unknown; [key: string]: unknown }} ImageVariant
 */

const {
  buildChatRequestBodyWithModelResolver,
  buildResponsesRequestBodyWithModelResolver,
} = require("../simple-page-request-builders.cjs");
const {
  resolveRequestModelName,
} = require("../simple-page-request-summary.cjs");

/**
 * @param {TranslationRequestOptions} options
 * @param {ChatMessage[]} messages
 * @param {unknown} [maxTokens]
 * @returns {Record<string, unknown>}
 */
function buildChatRequestBody(
  options,
  messages,
  maxTokens = options.maxTokens,
) {
  return buildChatRequestBodyWithModelResolver(
    options,
    messages,
    maxTokens,
    resolveRequestModelName,
  );
}

/**
 * @param {TranslationRequestOptions} options
 * @param {ImageVariant[]} imageVariants
 * @param {string} promptText
 * @param {string} systemPrompt
 * @returns {Record<string, unknown>}
 */
function buildResponsesRequestBody(
  options,
  imageVariants,
  promptText,
  systemPrompt,
) {
  return buildResponsesRequestBodyWithModelResolver(
    options,
    imageVariants,
    promptText,
    systemPrompt,
    resolveRequestModelName,
  );
}

module.exports = {
  buildChatRequestBody,
  buildResponsesRequestBody,
};
