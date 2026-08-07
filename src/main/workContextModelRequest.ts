import type { TranslationOptions } from "./appSettings";
import type { ModelEndpointHandle } from "./pipeline/types";
import { tMain } from "./i18n";
import {
  createLinkedDeadlineController,
  readBoundedResponseText,
} from "./httpResponseBudget";
import {
  MAX_MODEL_HTTP_RESPONSE_BYTES,
  MODEL_HTTP_REQUEST_DEADLINE_MS,
} from "./networkBudgets";
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
  const deadline = createLinkedDeadlineController(
    options.abortSignal,
    MODEL_HTTP_REQUEST_DEADLINE_MS,
    "Work context model request",
  );
  const boundedOptions: TranslationOptions = {
    ...options,
    abortSignal: deadline.signal,
  };
  try {
    return boundedOptions.modelProvider === "openai-codex"
      ? await requestCodexText(
          endpoint,
          boundedOptions,
          systemPrompt,
          userPrompt,
          maxOutputTokens,
          runtime,
        )
      : await requestChatText(
          endpoint,
          boundedOptions,
          systemPrompt,
          userPrompt,
          maxOutputTokens,
          runtime,
        );
  } finally {
    deadline.cleanup();
  }
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
      options.abortSignal,
    );
    if (!response.ok) {
      throw runtime.modelHttpErrors.createHttpFailureError(
        options,
        {},
        response,
        rawText,
      );
    }
    return extractChatOutput(rawText, options, runtime);
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
    options.abortSignal,
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
  if (runtime.responseText.extractModelOutputFailure(parsed.rawResponse)) {
    throw runtime.modelHttpErrors.createEmptyOutputError(
      parsed.rawResponse,
      rawText,
      {},
      options,
    );
  }
  if (!parsed.outputText.trim()) {
    throw new Error(tMain("workContext.errors.emptyResponse"));
  }
  return parsed.outputText;
}

function extractChatOutput(
  rawText: string,
  options: TranslationOptions,
  runtime: WorkContextRequestRuntime,
): string {
  const parsed = JSON.parse(rawText) as unknown;
  if (runtime.responseText.extractModelOutputFailure(parsed)) {
    throw runtime.modelHttpErrors.createEmptyOutputError(
      parsed,
      rawText,
      {},
      options,
    );
  }
  const outputText = runtime.responseText.extractModelOutputText(parsed);
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
  signal?: AbortSignal | null,
): Promise<string> {
  try {
    return await readBoundedResponseText(response, {
      label: "Work context model response",
      maximumBytes: MAX_MODEL_HTTP_RESPONSE_BYTES,
      signal,
    });
  } catch (error) {
    throw errors.createModelTransportError(
      tMain("workContext.errors.requestFailed"),
      { status: response.status, statusText: response.statusText },
      error,
    );
  }
}
