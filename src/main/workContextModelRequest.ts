import type { TranslationOptions } from "./appSettings";
import type { ModelEndpointHandle } from "./pipeline/types";
import { tMain } from "./i18n";
import {
  createWorkContextRequestRuntime,
  type WorkContextChatMessage,
  type WorkContextRequestRuntime,
} from "./workContextRequestRuntime";

export async function requestWorkContextAnalysisText({
  endpoint,
  options,
  systemPrompt,
  userPrompt,
  maxOutputTokens,
  runtime = createWorkContextRequestRuntime(),
}: {
  endpoint: ModelEndpointHandle;
  options: TranslationOptions;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  runtime?: WorkContextRequestRuntime;
}): Promise<string> {
  return options.modelProvider === "openai-codex"
    ? requestCodexText(
        endpoint,
        options,
        systemPrompt,
        userPrompt,
        maxOutputTokens,
        runtime,
      )
    : requestChatText(
        endpoint,
        options,
        systemPrompt,
        userPrompt,
        maxOutputTokens,
        runtime,
      );
}

function buildMessages(
  systemPrompt: string,
  userPrompt: string,
): WorkContextChatMessage[] {
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
  runtime: WorkContextRequestRuntime,
): Promise<string> {
  const builders = runtime.requestBuilders;
  const summary = runtime.requestSummary;
  const body = builders.buildChatRequestBodyWithModelResolver(
    options,
    buildMessages(systemPrompt, userPrompt),
    maxOutputTokens,
    summary.resolveRequestModelName,
  );
  if (options.modelProvider !== "openai-api") {
    await runtime.logitBias.applyLocalForbiddenTokenBias(
      endpoint,
      options,
      body,
    );
  }
  return runtime.apiKeyRetry.runWithApiKeyRetry(options, async (apiKey) => {
    const response = await sendWorkContextRequest(
      `${endpoint.baseUrl}/chat/completions`,
      options,
      builders.buildChatRequestHeaders(options, apiKey),
      body,
      runtime.modelHttpErrors,
    );
    const rawText = await readWorkContextResponseText(
      response,
      runtime.modelHttpErrors,
    );
    if (!response.ok) {
      throw runtime.modelHttpErrors.createHttpFailureError(
        options,
        {},
        response,
        rawText,
      );
    }
    return extractChatOutput(rawText, runtime.responseText);
  });
}

async function requestCodexText(
  endpoint: ModelEndpointHandle,
  options: TranslationOptions,
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens: number,
  runtime: WorkContextRequestRuntime,
): Promise<string> {
  const builders = runtime.requestBuilders;
  const summary = runtime.requestSummary;
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
    runtime.modelHttpErrors,
  );
  const rawText = await readWorkContextResponseText(
    response,
    runtime.modelHttpErrors,
  );
  if (!response.ok) {
    throw runtime.modelHttpErrors.createHttpFailureError(
      options,
      {},
      response,
      rawText,
    );
  }
  const parsed = runtime.responseText.parseResponsesSseText(rawText);
  if (!parsed.outputText.trim()) {
    throw new Error(tMain("workContext.errors.emptyResponse"));
  }
  return parsed.outputText;
}

function extractChatOutput(
  rawText: string,
  responseText: WorkContextRequestRuntime["responseText"],
): string {
  const parsed = JSON.parse(rawText) as unknown;
  const outputText = responseText.extractModelOutputText(parsed);
  if (!outputText.trim()) {
    throw new Error(tMain("workContext.errors.emptyResponse"));
  }
  return outputText;
}

async function sendWorkContextRequest(
  url: string,
  options: TranslationOptions,
  headers: HeadersInit,
  body: unknown,
  errors: WorkContextRequestRuntime["modelHttpErrors"],
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });
  } catch (error) {
    throw errors.createModelTransportError(
      tMain("workContext.errors.requestFailed"),
      {},
      error,
    );
  }
}

async function readWorkContextResponseText(
  response: Response,
  errors: WorkContextRequestRuntime["modelHttpErrors"],
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw errors.createModelTransportError(
      tMain("workContext.errors.requestFailed"),
      { status: response.status, statusText: response.statusText },
      error,
    );
  }
}
