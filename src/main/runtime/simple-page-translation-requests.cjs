// @ts-check
/** @typedef {import("./runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { apiKey?: unknown; maxTokens?: unknown; promptMode?: unknown; promptOverrideText?: string | null; abortSignal?: AbortSignal | null; ocrBboxHints?: unknown; [key: string]: unknown }} TranslationRequestOptions
 * @typedef {{ baseUrl: string; [key: string]: unknown }} ModelServer
 * @typedef {{ role?: string; content?: unknown; [key: string]: unknown }} ChatMessage
 * @typedef {{ role: string; path: string; mime?: string; width?: unknown; height?: unknown; [key: string]: unknown }} ImageVariant
 * @typedef {Record<string, unknown>} RequestSummary
 * @typedef {{ outputText: string; rawResponse: unknown }} OutputResult
 */
const {
  buildSystemPrompt,
  getOverlayPrompt,
} = require("./simple-page-prompts.cjs");
const {
  allowOcrNoTextDetectedSkip,
} = require("./simple-page-language-profile.cjs");
const {
  isOpenAIApiProvider,
  isOpenAICodexProvider,
  resolveConfiguredCodexModel,
  resolveConfiguredCodexReasoningEffort,
  resolveProviderDisplayName,
} = require("./simple-page-model-config.cjs");
const {
  extractModelOutputFailure,
  extractModelOutputText,
  parseResponsesSseText,
} = require("./simple-page-response-text.cjs");
const { inspectModelLaunch } = require("./simple-page-model-assets.cjs");
const { prepareImageVariants } = require("./simple-page-image-variants.cjs");
const { collectOcrBboxHints } = require("./simple-page-ocr-bbox-pipeline.cjs");
const {
  applyLocalForbiddenTokenBias,
} = require("./simple-page-logit-bias.cjs");
const {
  buildRequestSummary,
  resolveRequestModelName,
} = require("./simple-page-request-summary.cjs");
const {
  buildChatRequestBodyWithModelResolver,
  buildChatRequestHeaders,
  buildMessages,
  buildResponsesRequestBodyWithModelResolver,
  resolveConfiguredApiCustomHeaders,
  resolveConfiguredApiExtraBody,
} = require("./simple-page-request-builders.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  nowMs,
  truncateText,
} = require("./simple-page-runtime-common.cjs");

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

/**
 * @param {TranslationRequestOptions} options
 * @param {RequestSummary} requestSummary
 * @param {Response} response
 * @param {string} rawText
 * @returns {Error}
 */
function createHttpFailureError(options, requestSummary, response, rawText) {
  const nonRetriable = isNonRetriableHttpStatus(response.status);
  const message = buildHttpFailureMessage(
    options,
    response.status,
    response.statusText,
  );
  return createDetailedError(message, {
    requestSummary,
    status: response.status,
    statusText: response.statusText,
    rawTextPreview: truncateSensitiveText(rawText, options, 4000),
    ...(nonRetriable
      ? { nonRetriable: true, failureCategory: "model-request" }
      : {}),
  });
}

/**
 * @param {TranslationRequestOptions} options
 * @param {number} status
 * @param {string} statusText
 * @returns {string}
 */
function buildHttpFailureMessage(options, status, statusText) {
  const providerName = resolveProviderDisplayName(options);
  const statusLabel = formatHttpStatus(status, statusText);
  if (isOpenAIApiProvider(options)) {
    if (status === 401 || status === 403) {
      return `API 오류 ${statusLabel}: 인증에 실패했습니다. API 키가 잘못됐거나 만료됐을 수 있습니다. 키가 맞다면 선택한 모델이 이미지 입력을 지원하는지 확인하세요. 자세한 내용은 로그를 확인하세요.`;
    }
    if (isNonRetriableHttpStatus(status)) {
      return `API 오류 ${statusLabel}: 요청이 거부되었습니다. API 키 또는 Base URL이 맞는지, 선택한 모델이 이미지 입력을 지원하는지 확인하세요. 자세한 내용은 로그를 확인하세요.`;
    }
    return `API 오류 ${statusLabel}: 요청이 실패했습니다. 잠시 후 다시 시도하거나 로그를 확인하세요.`;
  }

  return `${providerName} request failed (${status}).`;
}

/**
 * @param {number} status
 * @param {unknown} statusText
 * @returns {string}
 */
function formatHttpStatus(status, statusText) {
  const suffix = String(statusText ?? "").trim();
  return suffix ? `${status} ${suffix}` : String(status);
}

/**
 * @param {number} status
 * @returns {boolean}
 */
function isNonRetriableHttpStatus(status) {
  return (
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409 &&
    status !== 425 &&
    status !== 429
  );
}

/**
 * @param {unknown} value
 * @param {TranslationRequestOptions} options
 * @param {number} maxLength
 * @returns {string}
 */
function truncateSensitiveText(value, options, maxLength) {
  return truncateText(redactConfiguredApiKeys(value, options), maxLength);
}

/**
 * @param {unknown} value
 * @param {TranslationRequestOptions} options
 * @returns {string}
 */
function redactConfiguredApiKeys(value, options) {
  let text = String(value ?? "");
  const keys = [
    options.apiKey,
    process.env.MANGA_TRANSLATOR_API_KEY,
    process.env.OPENAI_API_KEY,
    ...collectSensitiveConfiguredValues(options),
  ]
    .map((key) => String(key ?? "").trim())
    .filter((key) => key.length >= 6);
  for (const key of new Set(keys)) {
    text = text.split(key).join("[redacted-api-key]");
  }
  return text;
}

/**
 * @param {TranslationRequestOptions} options
 * @returns {unknown[]}
 */
function collectSensitiveConfiguredValues(options) {
  /** @type {unknown[]} */
  const values = [];
  try {
    for (const [key, value] of Object.entries(
      resolveConfiguredApiCustomHeaders(options),
    )) {
      if (isSensitiveConfigKey(key)) {
        values.push(value);
      }
    }
  } catch (_error) {
    // The original settings parse error will be reported by the request path.
  }
  try {
    collectSensitiveObjectValues(
      resolveConfiguredApiExtraBody(options),
      values,
    );
  } catch (_error) {
    // The original settings parse error will be reported by the request path.
  }
  return values;
}

/**
 * @param {unknown} value
 * @param {unknown[]} values
 * @param {string} [keyName]
 * @returns {void}
 */
function collectSensitiveObjectValues(value, values, keyName = "") {
  if (value === null || value === undefined) {
    return;
  }
  if (
    isSensitiveConfigKey(keyName) &&
    (typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean")
  ) {
    values.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) =>
      collectSensitiveObjectValues(item, values, keyName),
    );
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    collectSensitiveObjectValues(nestedValue, values, key);
  }
}

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isSensitiveConfigKey(key) {
  return /api[-_ ]?key|token|secret|authorization|auth|password/i.test(
    String(key ?? ""),
  );
}

/**
 * @param {ModelServer} server
 * @param {TranslationRequestOptions} options
 * @returns {Promise<{ requestBody: RequestSummary; rawResponse: unknown; outputText: string }>}
 */
async function requestTranslation(server, options) {
  const requestStartedAt = nowMs();
  const ocrBboxResult = await collectOcrBboxHints(options);
  const promptOptions =
    /** @type {TranslationRequestOptions & { ocrBboxHints: Record<string, unknown>[] }} */ ({
      ...options,
      ocrBboxHints: /** @type {Record<string, unknown>[]} */ (
        ocrBboxResult.hints
      ),
    });

  // OCR "텍스트 없음" 스킵 최적화는 일본어 원문에서만 안전하다. 다른 원문
  // 언어는 OCR false negative가 더 위험하므로 항상 모델을 호출한다.
  if (ocrBboxResult.noTextDetected && allowOcrNoTextDetectedSkip(options)) {
    const systemPrompt = buildSystemPrompt(promptOptions);
    const requestSummary = buildRequestSummary(
      server,
      promptOptions,
      [],
      "",
      systemPrompt,
    );
    requestSummary.noTextDetected = true;
    requestSummary.ocrTextEvidenceCount = ocrBboxResult.textEvidenceCount;
    if (ocrBboxResult.diagnostics.length > 0) {
      requestSummary.ocrBboxDiagnostics = ocrBboxResult.diagnostics;
    }
    emitRuntimeProgress(
      promptOptions,
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

  const preparedVariants = await prepareImageVariants(
    /** @type {Parameters<typeof prepareImageVariants>[0]} */ (options),
  );
  const imageVariants = preparedVariants.imageVariants;
  const promptText =
    promptOptions.promptOverrideText ||
    getOverlayPrompt(promptOptions, imageVariants);
  const systemPrompt = buildSystemPrompt(promptOptions);
  const requestBody = isOpenAICodexProvider(options)
    ? buildResponsesRequestBody(
        promptOptions,
        imageVariants,
        promptText,
        systemPrompt,
      )
    : buildChatRequestBody(
        promptOptions,
        buildMessages(promptOptions, imageVariants),
      );
  const requestSummary = buildRequestSummary(
    server,
    promptOptions,
    imageVariants,
    promptText,
    systemPrompt,
  );
  requestSummary.noTextDetected = false;
  requestSummary.ocrTextEvidenceCount = ocrBboxResult.textEvidenceCount;
  if (preparedVariants.diagnostics.length > 0) {
    requestSummary.imageVariantDiagnostics = preparedVariants.diagnostics;
  }
  if (ocrBboxResult.diagnostics.length > 0) {
    requestSummary.ocrBboxDiagnostics = ocrBboxResult.diagnostics;
  }

  if (isOpenAICodexProvider(options)) {
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

  if (!isOpenAIApiProvider(promptOptions)) {
    requestSummary.localForbiddenTokenBias = await applyLocalForbiddenTokenBias(
      server,
      promptOptions,
      requestBody,
    );
  }

  let response;
  try {
    emitRuntimeProgress(
      promptOptions,
      "model_requesting",
      isOpenAIApiProvider(promptOptions)
        ? "API 번역 요청 중"
        : "Gemma 4 번역 요청 중",
      resolveRequestModelName(promptOptions),
    );
    response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildChatRequestHeaders(promptOptions),
      body: JSON.stringify(requestBody),
      signal: promptOptions.abortSignal,
    });
  } catch (error) {
    throw createDetailedError(
      `${resolveProviderDisplayName(promptOptions)} request transport failed.`,
      { requestSummary },
      error,
    );
  }

  const rawText = await readResponseText(
    response,
    requestSummary,
    promptOptions,
  );
  requestSummary.performance = {
    wallMs: Math.round(nowMs() - requestStartedAt),
    provider: resolveProviderDisplayName(promptOptions),
    measuredAt: new Date().toISOString(),
  };

  if (!response.ok) {
    throw createHttpFailureError(
      promptOptions,
      requestSummary,
      response,
      rawText,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw createDetailedError(
      `${resolveProviderDisplayName(promptOptions)} response JSON parse failed.`,
      {
        requestSummary,
        rawTextPreview: truncateSensitiveText(rawText, promptOptions, 4000),
      },
      error,
    );
  }

  const outputText = extractModelOutputText(parsed);

  if (!outputText.trim()) {
    throw createEmptyOutputError(
      parsed,
      rawText,
      requestSummary,
      promptOptions,
    );
  }

  return {
    requestBody: requestSummary,
    rawResponse: parsed,
    outputText,
  };
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
    throw createDetailedError(
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

/**
 * @param {Response} response
 * @param {RequestSummary} requestSummary
 * @param {TranslationRequestOptions} options
 * @returns {Promise<string>}
 */
async function readResponseText(response, requestSummary, options) {
  try {
    return await response.text();
  } catch (error) {
    throw createDetailedError(
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
  if (!outputText) {
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

/**
 * @param {ModelServer} server
 * @param {TranslationRequestOptions} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function testModelReply(server, options) {
  if (isOpenAICodexProvider(options)) {
    return testCodexResponsesReply(server, options);
  }

  const messages = [
    {
      role: "system",
      content: [{ type: "text", text: "Reply in one short sentence." }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Say 'model test ok'." }],
    },
  ];
  const requestBody = buildChatRequestBody(options, messages, 48);
  if (!isOpenAIApiProvider(options)) {
    await applyLocalForbiddenTokenBias(server, options, requestBody);
  }

  let response;
  try {
    response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildChatRequestHeaders(options),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw createDetailedError(
      "모델 테스트 요청을 보내지 못했습니다.",
      {
        requestBody: {
          ...requestBody,
          messages: requestBody.messages,
        },
      },
      error,
    );
  }

  const rawText = await response.text();
  if (!response.ok) {
    throw createHttpFailureError(options, {}, response, rawText);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw createDetailedError(
      "모델 테스트 응답을 JSON으로 읽지 못했습니다.",
      {
        rawTextPreview: truncateSensitiveText(rawText, options, 4000),
      },
      error,
    );
  }

  const content = parsed?.choices?.[0]?.message?.content;
  const outputText =
    typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
        ? content
            .map((item) => item?.text || "")
            .join("\n")
            .trim()
        : "";

  if (!outputText) {
    throw createEmptyOutputError(parsed, rawText, {}, options);
  }

  return {
    outputText,
    launchTarget: inspectModelLaunch(options),
  };
}

/**
 * @param {unknown} parsed
 * @param {string} rawText
 * @param {RequestSummary} requestSummary
 * @param {TranslationRequestOptions} options
 * @returns {Error}
 */
function createEmptyOutputError(parsed, rawText, requestSummary, options) {
  const failure = extractModelOutputFailure(
    /** @type {Record<string, unknown>} */ (
      parsed && typeof parsed === "object" ? parsed : {}
    ),
  );
  if (failure) {
    return createDetailedError(failure.message, {
      requestSummary,
      rawTextPreview: truncateSensitiveText(rawText, options, 4000),
      rawResponse: parsed,
      failureCategory: failure.failureCategory,
      ...(failure.nonRetriable ? { nonRetriable: true } : {}),
    });
  }
  return createDetailedError("Model returned an empty response.", {
    requestSummary,
    rawTextPreview: truncateSensitiveText(rawText, options, 4000),
    rawResponse: parsed,
    failureCategory: "empty-model-response",
  });
}

/**
 * @param {ModelServer} server
 * @param {TranslationRequestOptions} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function testCodexResponsesReply(server, options) {
  const requestBody = {
    model: resolveRequestModelName(
      /** @type {Parameters<typeof resolveRequestModelName>[0]} */ (options),
    ),
    instructions: "Reply in one short sentence.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Say 'model test ok'." }],
      },
    ],
    reasoning: {
      effort: resolveConfiguredCodexReasoningEffort(options),
    },
    stream: true,
    store: false,
  };

  let response;
  try {
    response = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers: buildChatRequestHeaders(options),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw createDetailedError(
      "모델 테스트 요청을 보내지 못했습니다.",
      {
        requestBody,
      },
      error,
    );
  }

  if (!response.ok) {
    const rawText = await readResponseText(response, {}, options);
    throw createHttpFailureError(options, {}, response, rawText);
  }

  const result = await readCodexResponsesStream(response, {}, options);

  return {
    outputText: result.outputText,
    launchTarget: inspectModelLaunch(options),
  };
}

module.exports = {
  buildChatRequestBody,
  buildResponsesRequestBody,
  buildHttpFailureMessage,
  requestTranslation,
  testModelReply,
};
