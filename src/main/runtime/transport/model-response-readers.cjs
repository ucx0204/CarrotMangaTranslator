// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { [key: string]: unknown }} TranslationRequestOptions
 * @typedef {Record<string, unknown>} RequestSummary
 * @typedef {{ outputText: string; rawResponse: unknown }} OutputResult
 */

const {
  resolveProviderDisplayName,
} = require("../simple-page-model-config.cjs");
const {
  extractModelOutputFailure,
  parseResponsesSseText,
} = require("../simple-page-response-text.cjs");
const {
  createEmptyOutputError,
  createModelTransportError,
} = require("./model-http-errors.cjs");

/**
 * @param {Response} response
 * @param {RequestSummary} requestSummary
 * @param {TranslationRequestOptions} options
 */
async function readResponseText(response, requestSummary, options) {
  try {
    return await response.text();
  } catch (error) {
    throw createModelTransportError(
      `Failed to read ${resolveProviderDisplayName(options)} response body.`,
      {
        requestSummary,
        status: response.status,
        statusText: response.statusText,
      },
      error,
    );
  }
}

/**
 * @param {Response} response
 * @param {RequestSummary} requestSummary
 * @param {TranslationRequestOptions} options
 * @returns {Promise<OutputResult>}
 */
async function readCodexResponsesStream(response, requestSummary, options) {
  const rawText = await readResponseText(response, requestSummary, options);
  const parsed = parseResponsesSseText(rawText);
  const outputText = parsed.outputText.trim();
  if (extractModelOutputFailure(parsed.rawResponse) || !outputText) {
    throw createEmptyOutputError(
      parsed.rawResponse,
      rawText,
      requestSummary,
      options,
    );
  }

  return {
    outputText,
    rawResponse: {
      ...(parsed.rawResponse ?? {}),
      output_text: outputText,
      streamEventCount: parsed.eventCount,
    },
  };
}

module.exports = {
  readCodexResponsesStream,
  readResponseText,
};
