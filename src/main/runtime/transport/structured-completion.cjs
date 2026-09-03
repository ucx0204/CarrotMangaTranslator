// @ts-check

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { abortSignal?:AbortSignal|null; [key:string]:unknown }} StructuredOptions
 * @typedef {{baseUrl:string;[key:string]:unknown}} ModelServer
 * @typedef {Record<string,unknown>} RequestSummary
 */

const {
  isOpenAIApiProvider,
  isOpenAICodexProvider,
} = require("../simple-page-model-config.cjs");
const {
  isGoogleOpenAiCompatibleEndpoint,
} = require("../simple-page-request-builders.cjs");
const {
  applyLocalForbiddenTokenBias,
} = require("../simple-page-logit-bias.cjs");
const { runWithApiKeyRetry } = require("./api-key-retry.cjs");
const {
  readChatCompletionResult,
  sendChatCompletion,
} = require("./chat-completion.cjs");
const { requestResponsesText } = require("./responses-completion.cjs");

/**
 * One transport boundary for schema-constrained requests. It keeps local
 * llama token bias local, routes Codex through Responses, and gives every
 * OpenAI-compatible API stage the same credential rotation behavior.
 *
 * @param {ModelServer} server
 * @param {StructuredOptions} options
 * @param {Record<string,unknown>} requestBody
 * @param {RequestSummary} requestSummary
 * @param {number} requestStartedAt
 */
async function requestStructuredCompletion(
  server,
  options,
  requestBody,
  requestSummary,
  requestStartedAt,
) {
  if (isOpenAICodexProvider(options)) {
    const response = await requestResponsesText(
      server,
      options,
      requestBody,
      requestSummary,
    );
    return {
      response: {
        requestBody: requestSummary,
        rawResponse: response.rawResponse,
        outputText: response.outputText,
      },
      forbiddenTokenBias: null,
    };
  }

  const forbiddenTokenBias = isOpenAIApiProvider(options)
    ? null
    : await applyLocalForbiddenTokenBias(server, options, requestBody);
  const response = await requestApiStructuredChatCompletion(
    server,
    options,
    requestBody,
    requestSummary,
    requestStartedAt,
  );
  return { response, forbiddenTokenBias };
}

/**
 * OpenAI-compatible providers do not expose one universal structured-output
 * capability. Try the strict schema first, then make one bounded downgrade to
 * JSON mode only when the provider explicitly rejects that schema contract.
 * The semantic response parser still validates the result before it is used.
 *
 * @param {ModelServer} server
 * @param {StructuredOptions} options
 * @param {Record<string,unknown>} requestBody
 * @param {RequestSummary} requestSummary
 * @param {number} requestStartedAt
 */
async function requestApiStructuredChatCompletion(
  server,
  options,
  requestBody,
  requestSummary,
  requestStartedAt,
) {
  try {
    return await requestChatCompletionWithKeyRetry(
      server,
      options,
      requestBody,
      requestSummary,
      requestStartedAt,
    );
  } catch (error) {
    const fallbackBody = buildJsonObjectFallback(options, requestBody, error);
    if (!fallbackBody) throw error;
    requestSummary.structuredOutputFallback = "json_object";
    return requestChatCompletionWithKeyRetry(
      server,
      options,
      fallbackBody,
      requestSummary,
      requestStartedAt,
    );
  }
}

/**
 * @param {ModelServer} server
 * @param {StructuredOptions} options
 * @param {Record<string,unknown>} requestBody
 * @param {RequestSummary} requestSummary
 * @param {number} requestStartedAt
 */
function requestChatCompletionWithKeyRetry(
  server,
  options,
  requestBody,
  requestSummary,
  requestStartedAt,
) {
  return runWithApiKeyRetry(options, async (apiKey) => {
    const completion = await sendChatCompletion(
      server,
      options,
      requestBody,
      requestSummary,
      apiKey,
    );
    return readChatCompletionResult(
      completion,
      options,
      requestSummary,
      requestStartedAt,
    );
  });
}

/**
 * @param {StructuredOptions} options
 * @param {Record<string,unknown>} requestBody
 * @param {unknown} error
 * @returns {Record<string,unknown>|null}
 */
function buildJsonObjectFallback(options, requestBody, error) {
  if (!isOpenAIApiProvider(options) || !isJsonSchemaRequest(requestBody)) {
    return null;
  }
  const detail = readErrorRecord(error);
  if (detail.apiKeyRetryable === true) return null;
  if (detail.status !== 400 && detail.status !== 422) return null;
  const preview = String(detail.rawTextPreview ?? detail.message ?? "");
  const providerRejectedSchema =
    /invalid[_ ]argument|invalid schema|response[_ ]?format|json[_ ]?schema|structured output/i.test(
      preview,
    );
  if (!providerRejectedSchema && !isGoogleOpenAiCompatibleEndpoint(options)) {
    return null;
  }
  return { ...requestBody, response_format: { type: "json_object" } };
}

/** @param {Record<string,unknown>} requestBody */
function isJsonSchemaRequest(requestBody) {
  const responseFormat = readErrorRecord(requestBody.response_format);
  return responseFormat.type === "json_schema";
}

/** @param {unknown} value @returns {Record<string,unknown>} */
function readErrorRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string,unknown>} */ (value)
    : {};
}

module.exports = {
  buildJsonObjectFallback,
  requestStructuredCompletion,
};
