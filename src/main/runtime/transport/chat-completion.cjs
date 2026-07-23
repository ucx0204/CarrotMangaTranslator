// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { apiKey?: unknown; abortSignal?: AbortSignal | null; [key: string]: unknown }} ChatCompletionOptions
 * @typedef {{ baseUrl: string; [key: string]: unknown }} ModelServer
 * @typedef {Record<string, unknown>} RequestSummary
 */

const {
  isOpenAIApiProvider,
  resolveProviderDisplayName,
} = require("../simple-page-model-config.cjs");
const { extractModelOutputText } = require("../simple-page-response-text.cjs");
const {
  buildChatRequestHeaders,
} = require("../simple-page-request-builders.cjs");
const {
  resolveRequestModelName,
} = require("../simple-page-request-summary.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  nowMs,
} = require("./model-runtime-services.cjs");
const {
  createEmptyOutputError,
  createHttpFailureError,
  createModelTransportError,
  truncateSensitiveText,
} = require("./model-http-errors.cjs");
const { readResponseText } = require("./model-response-readers.cjs");

/**
 * @param {ModelServer} server
 * @param {ChatCompletionOptions} options
 * @param {Record<string, unknown>} requestBody
 * @param {RequestSummary} requestSummary
 * @param {string | undefined} apiKey
 * @returns {Promise<Response>}
 */
async function sendChatCompletion(
  server,
  options,
  requestBody,
  requestSummary,
  apiKey,
) {
  emitRuntimeProgress(
    options,
    "model_requesting",
    isOpenAIApiProvider(options) ? "API 번역 요청 중" : "Gemma 4 번역 요청 중",
    resolveRequestModelName(options),
  );
  try {
    return await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildChatRequestHeaders(options, apiKey),
      body: JSON.stringify(requestBody),
      signal: options.abortSignal,
    });
  } catch (error) {
    throw createModelTransportError(
      `${resolveProviderDisplayName(options)} request transport failed.`,
      { requestSummary },
      error,
    );
  }
}

/**
 * @param {Response} response
 * @param {ChatCompletionOptions} options
 * @param {RequestSummary} requestSummary
 * @param {number} requestStartedAt
 */
async function readChatCompletionResult(
  response,
  options,
  requestSummary,
  requestStartedAt,
) {
  const rawText = await readResponseText(response, requestSummary, options);
  requestSummary.performance = {
    wallMs: Math.round(nowMs() - requestStartedAt),
    provider: resolveProviderDisplayName(options),
    measuredAt: new Date().toISOString(),
  };
  if (!response.ok) {
    throw createHttpFailureError(options, requestSummary, response, rawText);
  }

  const parsed = parseChatResponse(rawText, options, requestSummary);
  const outputText = extractModelOutputText(parsed);
  if (!outputText.trim()) {
    throw createEmptyOutputError(parsed, rawText, requestSummary, options);
  }
  return { requestBody: requestSummary, rawResponse: parsed, outputText };
}

/**
 * @param {string} rawText
 * @param {ChatCompletionOptions} options
 * @param {RequestSummary} requestSummary
 */
function parseChatResponse(rawText, options, requestSummary) {
  try {
    return /** @type {unknown} */ (JSON.parse(rawText));
  } catch (error) {
    throw createDetailedError(
      `${resolveProviderDisplayName(options)} response JSON parse failed.`,
      {
        requestSummary,
        rawTextPreview: truncateSensitiveText(rawText, options, 4000),
      },
      error,
    );
  }
}

module.exports = {
  readChatCompletionResult,
  sendChatCompletion,
};
