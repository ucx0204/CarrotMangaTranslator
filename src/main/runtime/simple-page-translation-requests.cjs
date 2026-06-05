const {
  buildSystemPrompt,
  getOverlayPrompt
} = require("./simple-page-prompts.cjs");
const {
  isOpenAICodexProvider,
  resolveConfiguredCodexModel,
  resolveConfiguredCodexReasoningEffort,
  resolveProviderDisplayName
} = require("./simple-page-model-config.cjs");
const {
  extractModelOutputText,
  parseResponsesSseText
} = require("./simple-page-response-text.cjs");
const {
  inspectModelLaunch
} = require("./simple-page-model-assets.cjs");
const {
  prepareImageVariants
} = require("./simple-page-image-variants.cjs");
const {
  collectOcrBboxHints
} = require("./simple-page-ocr-bbox-pipeline.cjs");
const {
  buildRequestSummary,
  resolveRequestModelName
} = require("./simple-page-request-summary.cjs");
const {
  buildChatRequestBodyWithModelResolver,
  buildChatRequestHeaders,
  buildMessages,
  buildResponsesRequestBodyWithModelResolver
} = require("./simple-page-request-builders.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  nowMs,
  truncateText
} = require("./simple-page-runtime-common.cjs");

function buildChatRequestBody(options, messages, maxTokens = options.maxTokens) {
  return buildChatRequestBodyWithModelResolver(options, messages, maxTokens, resolveRequestModelName);
}

function buildResponsesRequestBody(options, imageVariants, promptText, systemPrompt) {
  return buildResponsesRequestBodyWithModelResolver(options, imageVariants, promptText, systemPrompt, resolveRequestModelName);
}

async function requestTranslation(server, options) {
  const requestStartedAt = nowMs();
  const ocrBboxResult = await collectOcrBboxHints(options);
  const promptOptions = {
    ...options,
    ocrBboxHints: ocrBboxResult.hints
  };

  if (ocrBboxResult.noTextDetected) {
    const systemPrompt = buildSystemPrompt(promptOptions);
    const requestSummary = buildRequestSummary(server, promptOptions, [], "", systemPrompt);
    requestSummary.noTextDetected = true;
    requestSummary.ocrTextEvidenceCount = ocrBboxResult.textEvidenceCount;
    if (ocrBboxResult.diagnostics.length > 0) {
      requestSummary.ocrBboxDiagnostics = ocrBboxResult.diagnostics;
    }
    emitRuntimeProgress(promptOptions, "page_done", "페이지 텍스트 없음", "Paddle OCR에서 일본어 텍스트 근거를 찾지 못해 모델 호출을 생략했습니다.");
    return {
      requestBody: requestSummary,
      rawResponse: {
        skipped: true,
        reason: "ocr-no-text",
        noTextDetected: true,
        textEvidenceCount: ocrBboxResult.textEvidenceCount
      },
      outputText: "{\"items\":[]}"
    };
  }

  const preparedVariants = await prepareImageVariants(options);
  const imageVariants = preparedVariants.imageVariants;
  const promptText = promptOptions.promptOverrideText || getOverlayPrompt(promptOptions, imageVariants);
  const systemPrompt = buildSystemPrompt(promptOptions);
  const requestBody = isOpenAICodexProvider(options)
    ? buildResponsesRequestBody(promptOptions, imageVariants, promptText, systemPrompt)
    : buildChatRequestBody(promptOptions, buildMessages(promptOptions, imageVariants));
  const requestSummary = buildRequestSummary(server, promptOptions, imageVariants, promptText, systemPrompt);
  requestSummary.noTextDetected = false;
  requestSummary.ocrTextEvidenceCount = ocrBboxResult.textEvidenceCount;
  if (preparedVariants.diagnostics.length > 0) {
    requestSummary.imageVariantDiagnostics = preparedVariants.diagnostics;
  }
  if (ocrBboxResult.diagnostics.length > 0) {
    requestSummary.ocrBboxDiagnostics = ocrBboxResult.diagnostics;
  }

  if (isOpenAICodexProvider(options)) {
    emitRuntimeProgress(promptOptions, "model_requesting", "OpenAI Codex 번역 요청 중", `${resolveConfiguredCodexModel(promptOptions)}, thinking ${resolveConfiguredCodexReasoningEffort(promptOptions)}`);
    const finalResult = await requestCodexResponsesText(server, promptOptions, requestBody, requestSummary);
    return {
      requestBody: requestSummary,
      rawResponse: finalResult.rawResponse,
      outputText: finalResult.outputText
    };
  }

  let response;
  try {
    emitRuntimeProgress(promptOptions, "model_requesting", "Gemma 4 번역 요청 중", resolveRequestModelName(promptOptions));
    response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildChatRequestHeaders(promptOptions),
      body: JSON.stringify(requestBody),
      signal: promptOptions.abortSignal
    });
  } catch (error) {
    throw createDetailedError(`${resolveProviderDisplayName(promptOptions)} request transport failed.`, { requestSummary }, error);
  }

  const rawText = await readResponseText(response, requestSummary, promptOptions);
  requestSummary.performance = {
    wallMs: Math.round(nowMs() - requestStartedAt),
    provider: resolveProviderDisplayName(promptOptions),
    measuredAt: new Date().toISOString()
  };

  if (!response.ok) {
    throw createDetailedError(`${resolveProviderDisplayName(promptOptions)} request failed (${response.status}).`, {
      requestSummary,
      status: response.status,
      statusText: response.statusText,
      rawTextPreview: truncateText(rawText, 4000)
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw createDetailedError(
      `${resolveProviderDisplayName(promptOptions)} response JSON parse failed.`,
      {
        requestSummary,
        rawTextPreview: truncateText(rawText, 4000)
      },
      error
    );
  }

  const outputText = extractModelOutputText(parsed);

  if (!outputText.trim()) {
    throw createDetailedError("Model returned an empty response.", {
      requestSummary,
      rawTextPreview: truncateText(rawText, 4000)
    });
  }

  return {
    requestBody: requestSummary,
    rawResponse: parsed,
    outputText
  };
}

async function requestCodexResponsesText(server, options, requestBody, requestSummary) {
  let response;
  try {
    response = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers: buildChatRequestHeaders(options),
      body: JSON.stringify(requestBody),
      signal: options.abortSignal
    });
  } catch (error) {
    throw createDetailedError(`${resolveProviderDisplayName(options)} request transport failed.`, { requestSummary }, error);
  }

  if (!response.ok) {
    const rawText = await readResponseText(response, requestSummary, options);
    throw createDetailedError(`${resolveProviderDisplayName(options)} request failed (${response.status}).`, {
      requestSummary,
      status: response.status,
      statusText: response.statusText,
      rawTextPreview: truncateText(rawText, 4000)
    });
  }

  const streamResult = await readCodexResponsesStream(response, requestSummary, options);
  if (!streamResult.outputText.trim()) {
    throw createDetailedError("Model returned an empty response.", {
      requestSummary,
      rawResponse: streamResult.rawResponse
    });
  }

  return streamResult;
}

async function readResponseText(response, requestSummary, options) {
  try {
    return await response.text();
  } catch (error) {
    throw createDetailedError(
      `Failed to read ${resolveProviderDisplayName(options)} response body.`,
      {
        requestSummary,
        status: response.status,
        statusText: response.statusText
      },
      error
    );
  }
}

async function readCodexResponsesStream(response, requestSummary, options) {
  const rawText = await readResponseText(response, requestSummary, options);
  const parsed = parseResponsesSseText(rawText);
  const outputText = parsed.outputText.trim();
  if (!outputText) {
    throw createDetailedError("Model returned an empty response.", {
      requestSummary,
      rawTextPreview: truncateText(rawText, 4000),
      rawResponse: parsed.rawResponse
    });
  }

  return {
    outputText,
    rawResponse: {
      ...parsed.rawResponse,
      output_text: outputText,
      streamEventCount: parsed.eventCount
    }
  };
}

async function testModelReply(server, options) {
  if (isOpenAICodexProvider(options)) {
    return testCodexResponsesReply(server, options);
  }

  const messages = [
    {
      role: "system",
      content: [{ type: "text", text: "Reply in one short sentence." }]
    },
    {
      role: "user",
      content: [{ type: "text", text: "Say 'model test ok'." }]
    }
  ];
  const requestBody = buildChatRequestBody(options, messages, 48);

  let response;
  try {
    response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildChatRequestHeaders(options),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw createDetailedError("모델 테스트 요청을 보내지 못했습니다.", {
      requestBody: {
        ...requestBody,
        messages: requestBody.messages
      }
    }, error);
  }

  const rawText = await response.text();
  if (!response.ok) {
    throw createDetailedError(`모델 테스트 응답이 실패했습니다 (${response.status}).`, {
      status: response.status,
      statusText: response.statusText,
      rawTextPreview: truncateText(rawText, 4000)
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw createDetailedError("모델 테스트 응답을 JSON으로 읽지 못했습니다.", {
      rawTextPreview: truncateText(rawText, 4000)
    }, error);
  }

  const content = parsed?.choices?.[0]?.message?.content;
  const outputText = typeof content === "string"
    ? content.trim()
    : Array.isArray(content)
      ? content.map((item) => item?.text || "").join("\n").trim()
      : "";

  if (!outputText) {
    throw createDetailedError("모델 테스트 응답이 비어 있습니다.", {
      rawResponse: parsed
    });
  }

  return {
    outputText,
    launchTarget: inspectModelLaunch(options)
  };
}

async function testCodexResponsesReply(server, options) {
  const requestBody = {
    model: resolveRequestModelName(options),
    instructions: "Reply in one short sentence.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Say 'model test ok'." }]
      }
    ],
    reasoning: {
      effort: resolveConfiguredCodexReasoningEffort(options)
    },
    stream: true,
    store: false
  };

  let response;
  try {
    response = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers: buildChatRequestHeaders(options),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw createDetailedError("모델 테스트 요청을 보내지 못했습니다.", {
      requestBody
    }, error);
  }

  if (!response.ok) {
    const rawText = await readResponseText(response, {}, options);
    throw createDetailedError(`모델 테스트 응답이 실패했습니다 (${response.status}).`, {
      status: response.status,
      statusText: response.statusText,
      rawTextPreview: truncateText(rawText, 4000)
    });
  }

  const result = await readCodexResponsesStream(response, {}, options);

  return {
    outputText: result.outputText,
    launchTarget: inspectModelLaunch(options)
  };
}

module.exports = {
  buildChatRequestBody,
  buildResponsesRequestBody,
  requestTranslation,
  testModelReply
};
