import type { TranslationOptions } from "./appSettings";
import {
  assertRuntimeFunctions,
  loadAppRuntimeModule,
  type AppRuntimeModuleId,
} from "./runtimeModuleLoader";

export type WorkContextChatMessage = {
  role: "system" | "user";
  content: Array<{ type: "text"; text: string }>;
};

export type WorkContextRequestRuntime = {
  apiKeyRetry: {
    runWithApiKeyRetry: <TResult>(
      options: TranslationOptions,
      requestAttempt: (apiKey: string | undefined) => Promise<TResult>,
    ) => Promise<TResult>;
  };
  logitBias: {
    applyLocalForbiddenTokenBias: (
      server: { baseUrl: string },
      options: TranslationOptions,
      requestBody: unknown,
    ) => Promise<unknown>;
  };
  modelHttpErrors: {
    createEmptyOutputError: (
      parsed: unknown,
      rawText: string,
      requestSummary: Record<string, unknown>,
      options: TranslationOptions,
    ) => Error;
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
  requestBuilders: {
    buildChatRequestBodyWithModelResolver: (
      options: TranslationOptions,
      messages: WorkContextChatMessage[],
      maxTokens: number,
      resolveRequestModelName: (options: TranslationOptions) => string,
    ) => unknown;
    buildChatRequestHeaders: (
      options: TranslationOptions,
      apiKeyOverride?: string,
    ) => HeadersInit;
  };
  requestSummary: {
    resolveRequestModelName: (options: TranslationOptions) => string;
  };
  responseText: {
    extractModelOutputFailure: (parsed: unknown) => {
      message: string;
      failureCategory: string;
      nonRetriable?: boolean;
      outputTruncated?: boolean;
    } | null;
    extractModelOutputText: (parsed: unknown) => string;
    parseResponsesSseText: (rawText: string) => {
      outputText: string;
      rawResponse: unknown;
      eventCount: number;
    };
  };
};

export type WorkContextRuntimeModuleLoader = (
  moduleId: AppRuntimeModuleId,
) => unknown;

export function createWorkContextRequestRuntime(
  loadModule: WorkContextRuntimeModuleLoader = loadAppRuntimeModule,
): WorkContextRequestRuntime {
  const apiKeyRetry = loadModule("apiKeyRetry");
  assertApiKeyRetryModule(apiKeyRetry);
  const logitBias = loadModule("logitBias");
  assertLogitBiasModule(logitBias);
  const modelHttpErrors = loadModule("modelHttpErrors");
  assertModelHttpErrorsModule(modelHttpErrors);
  const requestBuilders = loadModule("requestBuilders");
  assertRequestBuildersModule(requestBuilders);
  const requestSummary = loadModule("requestSummary");
  assertRequestSummaryModule(requestSummary);
  const responseText = loadModule("responseText");
  assertResponseTextModule(responseText);

  return {
    apiKeyRetry,
    logitBias,
    modelHttpErrors,
    requestBuilders,
    requestSummary,
    responseText,
  } satisfies WorkContextRequestRuntime;
}

function assertApiKeyRetryModule(
  value: unknown,
): asserts value is WorkContextRequestRuntime["apiKeyRetry"] {
  assertRuntimeFunctions(value, "transport/api-key-retry.cjs", [
    "runWithApiKeyRetry",
  ]);
}

function assertLogitBiasModule(
  value: unknown,
): asserts value is WorkContextRequestRuntime["logitBias"] {
  assertRuntimeFunctions(value, "simple-page-logit-bias.cjs", [
    "applyLocalForbiddenTokenBias",
  ]);
}

function assertModelHttpErrorsModule(
  value: unknown,
): asserts value is WorkContextRequestRuntime["modelHttpErrors"] {
  assertRuntimeFunctions(value, "transport/model-http-errors.cjs", [
    "createEmptyOutputError",
    "createHttpFailureError",
    "createModelTransportError",
  ]);
}

function assertRequestBuildersModule(
  value: unknown,
): asserts value is WorkContextRequestRuntime["requestBuilders"] {
  assertRuntimeFunctions(value, "simple-page-request-builders.cjs", [
    "buildChatRequestBodyWithModelResolver",
    "buildChatRequestHeaders",
  ]);
}

function assertRequestSummaryModule(
  value: unknown,
): asserts value is WorkContextRequestRuntime["requestSummary"] {
  assertRuntimeFunctions(value, "simple-page-request-summary.cjs", [
    "resolveRequestModelName",
  ]);
}

function assertResponseTextModule(
  value: unknown,
): asserts value is WorkContextRequestRuntime["responseText"] {
  assertRuntimeFunctions(value, "simple-page-response-text.cjs", [
    "extractModelOutputFailure",
    "extractModelOutputText",
    "parseResponsesSseText",
  ]);
}
