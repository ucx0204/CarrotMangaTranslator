import { join } from "node:path";
import type { TranslationOptions } from "./appSettings";
import { getAppPaths } from "./appPaths";
import type { ModelEndpointHandle } from "./pipeline/types";
import { tMain } from "./i18n";

type ChatMessage = {
  role: "system" | "user";
  content: Array<{ type: "text"; text: string }>;
};

type RequestBuildersModule = {
  buildChatRequestBodyWithModelResolver: (
    options: TranslationOptions,
    messages: ChatMessage[],
    maxTokens: number,
    resolveRequestModelName: (options: TranslationOptions) => string,
  ) => unknown;
  buildChatRequestHeaders: (
    options: TranslationOptions,
    apiKeyOverride?: string,
  ) => HeadersInit;
};

type ApiKeyRetryModule = {
  runWithApiKeyRetry: <TResult>(
    options: TranslationOptions,
    requestAttempt: (apiKey: string | undefined) => Promise<TResult>,
  ) => Promise<TResult>;
};

type ModelHttpErrorsModule = {
  createHttpFailureError: (
    options: TranslationOptions,
    requestSummary: Record<string, unknown>,
    response: Response,
    rawText: string,
  ) => Error;
  createModelTransportError: (
    message: string,
    detail: Record<string, unknown>,
    cause: unknown,
  ) => Error;
};

type RequestSummaryModule = {
  resolveRequestModelName: (options: TranslationOptions) => string;
};

type ResponseTextModule = {
  extractModelOutputText: (parsed: unknown) => string;
  parseResponsesSseText: (rawText: string) => {
    outputText: string;
    rawResponse: unknown;
    eventCount: number;
  };
};

type LogitBiasModule = {
  applyLocalForbiddenTokenBias: (
    server: { baseUrl: string },
    options: TranslationOptions,
    requestBody: unknown,
  ) => Promise<unknown>;
};

let cachedRequestBuilders: RequestBuildersModule | null = null;
let cachedApiKeyRetry: ApiKeyRetryModule | null = null;
let cachedModelHttpErrors: ModelHttpErrorsModule | null = null;
let cachedRequestSummary: RequestSummaryModule | null = null;
let cachedResponseText: ResponseTextModule | null = null;
let cachedLogitBias: LogitBiasModule | null = null;

export async function requestWorkContextAnalysisText({
  endpoint,
  options,
  systemPrompt,
  userPrompt,
  maxOutputTokens,
}: {
  endpoint: ModelEndpointHandle;
  options: TranslationOptions;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
}): Promise<string> {
  return options.modelProvider === "openai-codex"
    ? requestCodexText(
        endpoint,
        options,
        systemPrompt,
        userPrompt,
        maxOutputTokens,
      )
    : requestChatText(
        endpoint,
        options,
        systemPrompt,
        userPrompt,
        maxOutputTokens,
      );
}

function buildMessages(
  systemPrompt: string,
  userPrompt: string,
): ChatMessage[] {
  return [
    {
      role: "system",
      content: [{ type: "text", text: systemPrompt }],
    },
    {
      role: "user",
      content: [{ type: "text", text: userPrompt }],
    },
  ];
}

async function requestChatText(
  endpoint: ModelEndpointHandle,
  options: TranslationOptions,
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number,
): Promise<string> {
  const builders = getRequestBuildersModule();
  const summary = getRequestSummaryModule();
  const body = builders.buildChatRequestBodyWithModelResolver(
    options,
    buildMessages(systemPrompt, userPrompt),
    maxOutputTokens,
    summary.resolveRequestModelName,
  );
  if (options.modelProvider !== "openai-api") {
    await getLogitBiasModule().applyLocalForbiddenTokenBias(
      endpoint,
      options,
      body,
    );
  }
  return getApiKeyRetryModule().runWithApiKeyRetry(options, async (apiKey) => {
    const response = await sendWorkContextRequest(
      `${endpoint.baseUrl}/chat/completions`,
      options,
      builders.buildChatRequestHeaders(options, apiKey),
      body,
    );
    const rawText = await readWorkContextResponseText(response);
    if (!response.ok) {
      throw getModelHttpErrorsModule().createHttpFailureError(
        options,
        {},
        response,
        rawText,
      );
    }
    return extractChatOutput(rawText);
  });
}

async function requestCodexText(
  endpoint: ModelEndpointHandle,
  options: TranslationOptions,
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number,
): Promise<string> {
  const builders = getRequestBuildersModule();
  const summary = getRequestSummaryModule();
  const body = {
    model: summary.resolveRequestModelName(options),
    instructions: systemPrompt,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: userPrompt }],
      },
    ],
    max_output_tokens: maxOutputTokens,
    reasoning: { effort: options.codexReasoningEffort },
    stream: true,
    store: false,
  };
  const response = await sendWorkContextRequest(
    `${endpoint.baseUrl}/responses`,
    options,
    builders.buildChatRequestHeaders(options),
    body,
  );
  const rawText = await readWorkContextResponseText(response);
  if (!response.ok) {
    throw getModelHttpErrorsModule().createHttpFailureError(
      options,
      {},
      response,
      rawText,
    );
  }
  const parsed = getResponseTextModule().parseResponsesSseText(rawText);
  if (!parsed.outputText.trim()) {
    throw new Error(tMain("workContext.errors.emptyResponse"));
  }
  return parsed.outputText;
}

function extractChatOutput(rawText: string): string {
  const parsed = JSON.parse(rawText) as unknown;
  const outputText = getResponseTextModule().extractModelOutputText(parsed);
  if (!outputText.trim()) {
    throw new Error(tMain("workContext.errors.emptyResponse"));
  }
  return outputText;
}

function getRequestBuildersModule(): RequestBuildersModule {
  if (!cachedRequestBuilders) {
    cachedRequestBuilders = requireRuntimeModule<RequestBuildersModule>(
      "simple-page-request-builders.cjs",
    );
  }
  return cachedRequestBuilders;
}

function getApiKeyRetryModule(): ApiKeyRetryModule {
  if (!cachedApiKeyRetry) {
    cachedApiKeyRetry = requireRuntimeModule<ApiKeyRetryModule>(
      "transport/api-key-retry.cjs",
    );
  }
  return cachedApiKeyRetry;
}

function getModelHttpErrorsModule(): ModelHttpErrorsModule {
  if (!cachedModelHttpErrors) {
    cachedModelHttpErrors = requireRuntimeModule<ModelHttpErrorsModule>(
      "transport/model-http-errors.cjs",
    );
  }
  return cachedModelHttpErrors;
}

function getRequestSummaryModule(): RequestSummaryModule {
  if (!cachedRequestSummary) {
    cachedRequestSummary = requireRuntimeModule<RequestSummaryModule>(
      "simple-page-request-summary.cjs",
    );
  }
  return cachedRequestSummary;
}

function getResponseTextModule(): ResponseTextModule {
  if (!cachedResponseText) {
    cachedResponseText = requireRuntimeModule<ResponseTextModule>(
      "simple-page-response-text.cjs",
    );
  }
  return cachedResponseText;
}

function getLogitBiasModule(): LogitBiasModule {
  if (!cachedLogitBias) {
    cachedLogitBias = requireRuntimeModule<LogitBiasModule>(
      "simple-page-logit-bias.cjs",
    );
  }
  return cachedLogitBias;
}

function requireRuntimeModule<TModule>(fileName: string): TModule {
  return require(join(getAppPaths().runtimeDir, fileName)) as TModule;
}

async function sendWorkContextRequest(
  url: string,
  options: TranslationOptions,
  headers: HeadersInit,
  body: unknown,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });
  } catch (error) {
    throw getModelHttpErrorsModule().createModelTransportError(
      tMain("workContext.errors.requestFailed"),
      {},
      error,
    );
  }
}

async function readWorkContextResponseText(
  response: Response,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw getModelHttpErrorsModule().createModelTransportError(
      tMain("workContext.errors.requestFailed"),
      { status: response.status, statusText: response.statusText },
      error,
    );
  }
}
