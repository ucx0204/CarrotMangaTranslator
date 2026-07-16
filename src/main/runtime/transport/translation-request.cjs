// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { apiKey?: unknown; maxTokens?: unknown; promptMode?: unknown; promptOverrideText?: string | null; abortSignal?: AbortSignal | null; ocrBboxHints?: unknown; [key: string]: unknown }} TranslationRequestOptions
 * @typedef {{ baseUrl: string; [key: string]: unknown }} ModelServer
 * @typedef {{ role: string; path: string; mime?: string; width?: unknown; height?: unknown; [key: string]: unknown }} ImageVariant
 * @typedef {Record<string, unknown>} RequestSummary
 * @typedef {{ outputText: string; rawResponse: unknown }} OutputResult
 * @typedef {{ hints: unknown[]; noTextDetected: boolean; textEvidenceCount: unknown; diagnostics: unknown[] }} OcrBboxResult
 * @typedef {TranslationRequestOptions & { ocrBboxHints: Record<string, unknown>[] }} PromptRequestOptions
 * @typedef {{ promptOptions: PromptRequestOptions; imageVariants: ImageVariant[]; requestBody: Record<string, unknown>; requestSummary: RequestSummary }} PreparedTranslationRequest
 */

const {
  buildSystemPrompt,
  getOverlayPrompt,
} = require("../simple-page-prompts.cjs");
const {
  allowOcrNoTextDetectedSkip,
} = require("../simple-page-language-profile.cjs");
const {
  isOpenAIApiProvider,
  isOpenAICodexProvider,
  resolveConfiguredCodexModel,
  resolveConfiguredCodexReasoningEffort,
  resolveProviderDisplayName,
} = require("../simple-page-model-config.cjs");
const { extractModelOutputText } = require("../simple-page-response-text.cjs");
const { prepareImageVariants } = require("../simple-page-image-variants.cjs");
const { collectOcrBboxHints } = require("../simple-page-ocr-bbox-pipeline.cjs");
const {
  applyLocalForbiddenTokenBias,
} = require("../simple-page-logit-bias.cjs");
const {
  buildRequestSummary,
  resolveRequestModelName,
} = require("../simple-page-request-summary.cjs");
const {
  buildChatRequestHeaders,
  buildMessages,
} = require("../simple-page-request-builders.cjs");
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
const { runWithApiKeyRetry } = require("./api-key-retry.cjs");
const {
  readCodexResponsesStream,
  readResponseText,
} = require("./model-response-readers.cjs");
const {
  buildChatRequestBody,
  buildResponsesRequestBody,
} = require("./request-bodies.cjs");

/**
 * @param {ModelServer} server
 * @param {TranslationRequestOptions} options
 * @returns {Promise<{ requestBody: RequestSummary; rawResponse: unknown; outputText: string }>}
 */
async function requestTranslation(server, options) {
  const requestStartedAt = nowMs();
  const ocrBboxResult = /** @type {OcrBboxResult} */ (
    await collectOcrBboxHints(options)
  );
  const promptOptions = createPromptOptions(options, ocrBboxResult.hints);

  if (shouldSkipModelRequest(ocrBboxResult, options)) {
    return createNoTextResult(server, promptOptions, ocrBboxResult);
  }

  const prepared = await prepareTranslationRequest(
    server,
    promptOptions,
    ocrBboxResult,
  );
  if (isOpenAICodexProvider(options)) {
    return requestCodexTranslation(server, prepared);
  }
  return requestChatTranslation(server, prepared, requestStartedAt);
}

/**
 * @param {TranslationRequestOptions} options
 * @param {unknown[]} hints
 * @returns {PromptRequestOptions}
 */
function createPromptOptions(options, hints) {
  return /** @type {PromptRequestOptions} */ ({
    ...options,
    ocrBboxHints: /** @type {Record<string, unknown>[]} */ (hints),
  });
}

/** @param {OcrBboxResult} result @param {TranslationRequestOptions} options */
function shouldSkipModelRequest(result, options) {
  return (
    !options.collectPageContext &&
    result.noTextDetected &&
    allowOcrNoTextDetectedSkip(options)
  );
}

/**
 * @param {ModelServer} server
 * @param {PromptRequestOptions} options
 * @param {OcrBboxResult} ocrBboxResult
 */
function createNoTextResult(server, options, ocrBboxResult) {
  const systemPrompt = buildSystemPrompt(options);
  const requestSummary = buildRequestSummary(
    server,
    options,
    [],
    "",
    systemPrompt,
  );
  requestSummary.noTextDetected = true;
  requestSummary.ocrTextEvidenceCount = ocrBboxResult.textEvidenceCount;
  addDiagnostics(
    requestSummary,
    "ocrBboxDiagnostics",
    ocrBboxResult.diagnostics,
  );
  emitRuntimeProgress(
    options,
    "page_done",
    "페이지 텍스트 없음",
    "Paddle OCR에서 일본어 텍스트 근거를 찾지 못해 모델 호출을 생략했습니다.",
  );
  return {
    requestBody: requestSummary,
    rawResponse: {
      skipped: true,
      reason: "ocr-no-text",
      noTextDetected: true,
      textEvidenceCount: ocrBboxResult.textEvidenceCount,
    },
    outputText: '{"items":[]}',
  };
}

/**
 * @param {ModelServer} server
 * @param {PromptRequestOptions} options
 * @param {OcrBboxResult} ocrBboxResult
 * @returns {Promise<PreparedTranslationRequest>}
 */
async function prepareTranslationRequest(server, options, ocrBboxResult) {
  const preparedVariants = await prepareImageVariants(
    /** @type {Parameters<typeof prepareImageVariants>[0]} */ (options),
  );
  const imageVariants = /** @type {ImageVariant[]} */ (
    preparedVariants.imageVariants
  );
  const promptText =
    options.promptOverrideText || getOverlayPrompt(options, imageVariants);
  const systemPrompt = buildSystemPrompt(options);
  const requestBody = buildProviderRequestBody(
    options,
    imageVariants,
    promptText,
    systemPrompt,
  );
  const requestSummary = buildRequestSummary(
    server,
    options,
    imageVariants,
    promptText,
    systemPrompt,
  );
  requestSummary.noTextDetected = ocrBboxResult.noTextDetected;
  requestSummary.ocrTextEvidenceCount = ocrBboxResult.textEvidenceCount;
  addDiagnostics(
    requestSummary,
    "imageVariantDiagnostics",
    preparedVariants.diagnostics,
  );
  addDiagnostics(
    requestSummary,
    "ocrBboxDiagnostics",
    ocrBboxResult.diagnostics,
  );
  return { promptOptions: options, imageVariants, requestBody, requestSummary };
}

/**
 * @param {PromptRequestOptions} options
 * @param {ImageVariant[]} imageVariants
 * @param {string} promptText
 * @param {string} systemPrompt
 */
function buildProviderRequestBody(
  options,
  imageVariants,
  promptText,
  systemPrompt,
) {
  if (isOpenAICodexProvider(options)) {
    return buildResponsesRequestBody(
      options,
      imageVariants,
      promptText,
      systemPrompt,
    );
  }
  return buildChatRequestBody(options, buildMessages(options, imageVariants));
}

/**
 * @param {RequestSummary} summary
 * @param {string} key
 * @param {unknown[]} diagnostics
 */
function addDiagnostics(summary, key, diagnostics) {
  if (diagnostics.length > 0) {
    summary[key] = diagnostics;
  }
}

/** @param {ModelServer} server @param {PreparedTranslationRequest} prepared */
async function requestCodexTranslation(server, prepared) {
  const { promptOptions, requestBody, requestSummary } = prepared;
  emitRuntimeProgress(
    promptOptions,
    "model_requesting",
    "OpenAI Codex 번역 요청 중",
    `${resolveConfiguredCodexModel(promptOptions)}, thinking ${resolveConfiguredCodexReasoningEffort(promptOptions)}`,
  );
  const finalResult = await requestCodexResponsesText(
    server,
    promptOptions,
    requestBody,
    requestSummary,
  );
  return {
    requestBody: requestSummary,
    rawResponse: finalResult.rawResponse,
    outputText: finalResult.outputText,
  };
}

/**
 * @param {ModelServer} server
 * @param {PreparedTranslationRequest} prepared
 * @param {number} requestStartedAt
 */
async function requestChatTranslation(server, prepared, requestStartedAt) {
  const { promptOptions, requestBody, requestSummary } = prepared;
  if (!isOpenAIApiProvider(promptOptions)) {
    requestSummary.localForbiddenTokenBias = await applyLocalForbiddenTokenBias(
      server,
      promptOptions,
      requestBody,
    );
  }
  return runWithApiKeyRetry(promptOptions, async (apiKey) => {
    const response = await sendChatCompletion(
      server,
      promptOptions,
      requestBody,
      requestSummary,
      apiKey,
    );
    return readChatCompletionResult(
      response,
      promptOptions,
      requestSummary,
      requestStartedAt,
    );
  });
}

/**
 * @param {ModelServer} server
 * @param {PromptRequestOptions} options
 * @param {Record<string, unknown>} requestBody
 * @param {RequestSummary} requestSummary
 * @param {string | undefined} apiKey
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
 * @param {TranslationRequestOptions} options
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
 * @param {TranslationRequestOptions} options
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

/**
 * @param {ModelServer} server
 * @param {TranslationRequestOptions} options
 * @param {Record<string, unknown>} requestBody
 * @param {RequestSummary} requestSummary
 * @returns {Promise<OutputResult>}
 */
async function requestCodexResponsesText(
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

module.exports = {
  requestTranslation,
  shouldSkipModelRequest,
};
