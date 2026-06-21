import { join } from "node:path";
import type { TranslationOptions } from "./appSettings";
import { getAppPaths } from "./appPaths";
import type { ModelEndpointHandle } from "./pipeline/types";

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
  buildChatRequestHeaders: (options: TranslationOptions) => HeadersInit;
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

let cachedRequestBuilders: RequestBuildersModule | null = null;
let cachedRequestSummary: RequestSummaryModule | null = null;
let cachedResponseText: ResponseTextModule | null = null;

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
  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: builders.buildChatRequestHeaders(options),
    body: JSON.stringify(body),
    signal: options.abortSignal,
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw makeModelError(
      "AI 작품 메모리 분석 요청이 실패했습니다.",
      response,
      rawText,
    );
  }
  return extractChatOutput(rawText);
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
  const response = await fetch(`${endpoint.baseUrl}/responses`, {
    method: "POST",
    headers: builders.buildChatRequestHeaders(options),
    body: JSON.stringify(body),
    signal: options.abortSignal,
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw makeModelError(
      "AI 작품 메모리 분석 요청이 실패했습니다.",
      response,
      rawText,
    );
  }
  const parsed = getResponseTextModule().parseResponsesSseText(rawText);
  if (!parsed.outputText.trim()) {
    throw new Error("AI 작품 메모리 분석 응답이 비어 있습니다.");
  }
  return parsed.outputText;
}

function extractChatOutput(rawText: string): string {
  const parsed = JSON.parse(rawText) as unknown;
  const outputText = getResponseTextModule().extractModelOutputText(parsed);
  if (!outputText.trim()) {
    throw new Error("AI 작품 메모리 분석 응답이 비어 있습니다.");
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

function requireRuntimeModule<TModule>(fileName: string): TModule {
  return require(join(getAppPaths().runtimeDir, fileName)) as TModule;
}

function makeModelError(
  message: string,
  response: Response,
  rawText: string,
): Error {
  const preview = rawText.replace(/\s+/g, " ").slice(0, 1200);
  return new Error(
    `${message} (${response.status} ${response.statusText}) ${preview}`,
  );
}
