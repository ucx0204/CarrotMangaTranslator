// @ts-check

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { abortSignal?: AbortSignal | null; [key:string]:unknown }} ResponsesOptions
 * @typedef {{baseUrl:string;[key:string]:unknown}} ModelServer
 * @typedef {Record<string,unknown>} RequestSummary
 */

const {
  buildChatRequestHeaders,
} = require("../simple-page-request-builders.cjs");
const {
  resolveProviderDisplayName,
} = require("../simple-page-model-config.cjs");
const {
  createEmptyOutputError,
  createHttpFailureError,
  createModelTransportError,
} = require("./model-http-errors.cjs");
const {
  readCodexResponsesStream,
  readResponseText,
} = require("./model-response-readers.cjs");

/**
 * @param {ModelServer} server
 * @param {ResponsesOptions} options
 * @param {Record<string,unknown>} requestBody
 * @param {RequestSummary} requestSummary
 */
async function requestResponsesText(
  server,
  options,
  requestBody,
  requestSummary,
) {
  let response;
  try {
    response = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers: buildChatRequestHeaders(options),
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

  if (!response.ok) {
    const rawText = await readResponseText(response, requestSummary, options);
    throw createHttpFailureError(options, requestSummary, response, rawText);
  }

  const streamResult = await readCodexResponsesStream(
    response,
    requestSummary,
    options,
  );
  if (!streamResult.outputText.trim()) {
    throw createEmptyOutputError(
      streamResult.rawResponse,
      JSON.stringify(streamResult.rawResponse),
      requestSummary,
      options,
    );
  }
  return streamResult;
}

module.exports = { requestResponsesText };
