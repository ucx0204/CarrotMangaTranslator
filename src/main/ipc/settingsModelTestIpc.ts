import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AppSettingsSchema, parseIpcPayload } from "../../shared/ipcSchemas";
import type { ModelTestResult } from "../../shared/jobTypes";
import { isAppActivityUnavailableError } from "../appActivityGate";
import { runManagedAppOperation } from "../appOperationRegistry";
import { throwIfAborted } from "../abortSignal";
import type { AppSettings } from "../../shared/settingsTypes";
import {
  buildBaseTranslationOptions,
  type TranslationOptions,
} from "../appSettings";
import { logError } from "../logger";
import {
  startCodexAppServerEndpoint,
  stopCodexAppServerEndpoint,
  type CodexAppServerEndpoint,
} from "../codexAppServerEndpoint";
import {
  createOpenAICompatibleApiEndpoint,
  isOpenAICompatibleApiEndpoint,
  type OpenAICompatibleApiEndpoint,
} from "../openaiApiEndpoint";
import {
  isCodexAppServerEndpoint,
  type SimplePageRuntime,
} from "../simplePageRuntime";
import type { IpcContext } from "./context";
import {
  createModelTestProgressSender,
  sendEnginePreparationProgress,
  verifyPaddleOcrRuntime,
  type ModelTestProgressEventSource,
  type SendModelTestProgress,
} from "./settingsModelTestProgress";
import { tMain } from "./localization";
import { reserveFreePort } from "./settingsModelTestPort";

const MAX_MODEL_TEST_ID_LENGTH = 200;
const SAFE_MODEL_TEST_ID_PATTERN = /^(?=.*[A-Za-z0-9_-])[A-Za-z0-9._-]+$/;
const MODEL_TEST_PORT_ATTEMPTS = 4;

type ModelTestServer =
  | Awaited<ReturnType<SimplePageRuntime["startServer"]>>
  | CodexAppServerEndpoint
  | OpenAICompatibleApiEndpoint;

export type ModelTestEndpointRuntime = {
  startCodexAppServerEndpoint: typeof startCodexAppServerEndpoint;
  stopCodexAppServerEndpoint: typeof stopCodexAppServerEndpoint;
};

const productionEndpointRuntime: ModelTestEndpointRuntime = {
  startCodexAppServerEndpoint,
  stopCodexAppServerEndpoint,
};

type ModelTestRunInput = {
  endpointRuntime: ModelTestEndpointRuntime;
  options: TranslationOptions;
  runtime: SimplePageRuntime;
  sendProgress: SendModelTestProgress;
  settings: AppSettings;
  testId: string;
};

export async function handleModelSettingsTest(
  context: IpcContext,
  event: ModelTestProgressEventSource,
  rawSettings: unknown,
  providedTestId: unknown,
  endpointRuntime: ModelTestEndpointRuntime = productionEndpointRuntime,
): Promise<ModelTestResult> {
  const settings = parseIpcPayload(
    AppSettingsSchema,
    rawSettings,
    tMain("settings.modelTestLabel"),
  );
  const testId = resolveModelTestId(providedTestId);
  if (context.jobs.hasActive) {
    return buildBusyModelTestResult(settings);
  }

  try {
    return await runManagedAppOperation(
      context.operations,
      {
        id: `model-test-${testId}`,
        kind: "model-test",
        mutatesLibrary: false,
      },
      async (signal) => {
        const options = await buildInitialModelTestOptions(
          context,
          settings,
          testId,
          signal,
        );
        return runModelTestWithServer({
          endpointRuntime,
          options,
          runtime: context.loadSimplePageRuntime(),
          sendProgress: createModelTestProgressSender(event, testId),
          settings,
          testId,
        });
      },
    );
  } catch (error) {
    if (isAppActivityUnavailableError(error)) {
      return buildBusyModelTestResult(settings);
    }
    throw error;
  }
}

function buildBusyModelTestResult(settings: AppSettings): ModelTestResult {
  return {
    ok: false,
    message: tMain("settings.modelTestBusy"),
    launchMode: resolveSettingsLaunchMode(settings),
  };
}

async function buildInitialModelTestOptions(
  context: IpcContext,
  settings: AppSettings,
  testId: string,
  signal: AbortSignal,
): Promise<TranslationOptions> {
  throwIfAborted(signal);
  const port =
    settings.modelProvider === "gemma" ? await reserveFreePort(signal) : 0;
  throwIfAborted(signal);
  return {
    ...buildBaseTranslationOptions({
      jobId: `settings-test-${testId}`,
      runDir: join(context.appPaths.dataRoot, "model-tests", testId),
      paths: context.appPaths,
      settings,
    }),
    onProgress: createNoopProgressBridge(),
    reuseServer: false,
    port,
    label: `settings-test-${testId}`,
    abortSignal: signal,
  };
}

function createNoopProgressBridge(): TranslationOptions["onProgress"] {
  return undefined;
}

async function runModelTestWithServer({
  endpointRuntime,
  options: initialOptions,
  runtime,
  sendProgress,
  settings,
  testId,
}: ModelTestRunInput): Promise<ModelTestResult> {
  let server: ModelTestServer | null = null;
  const signal = initialOptions.abortSignal ?? undefined;
  try {
    throwIfAborted(signal);
    sendModelTestBootProgress(sendProgress);
    const options = withModelTestProgress(initialOptions, sendProgress);
    throwIfAborted(signal);
    await verifyPaddleOcrRuntime(runtime, options, sendProgress);
    throwIfAborted(signal);
    sendEnginePreparationProgress(runtime, options, sendProgress);
    throwIfAborted(signal);
    const started = await startModelTestServerWithRetry(
      runtime,
      options,
      sendProgress,
      endpointRuntime,
    );
    server = started.server;
    throwIfAborted(signal);
    return await finishModelRuntimeTest(
      runtime,
      started.options,
      server,
      sendProgress,
    );
  } catch (error) {
    return handleModelTestFailure(error, settings, sendProgress, testId);
  } finally {
    await stopModelTestServer(runtime, server, endpointRuntime);
  }
}

function withModelTestProgress(
  options: TranslationOptions,
  sendProgress: SendModelTestProgress,
): TranslationOptions {
  return {
    ...options,
    onProgress: (progress) => {
      sendProgress(progress);
    },
  };
}

function sendModelTestBootProgress(sendProgress: SendModelTestProgress): void {
  sendProgress({
    phase: "booting",
    progressText: tMain("modelTest.preparing"),
    installLogLine: tMain("modelTest.startLog"),
  });
}

async function finishModelRuntimeTest(
  runtime: SimplePageRuntime,
  options: TranslationOptions,
  server: ModelTestServer,
  sendProgress: SendModelTestProgress,
): Promise<ModelTestResult> {
  throwIfAborted(options.abortSignal ?? undefined);
  sendProgress({
    phase: "ready",
    progressText: tMain("modelTest.serverReady"),
    detail: server.baseUrl,
    installLogLine: tMain("modelTest.serverReadyLog", {
      endpoint: server.baseUrl,
    }),
  });
  throwIfAborted(options.abortSignal ?? undefined);
  const result = await runtime.testModelReply(server, options);
  throwIfAborted(options.abortSignal ?? undefined);
  sendProgress({
    phase: "done",
    progressText: tMain("modelTest.completed"),
    detail: result.outputText,
    installLogLine: tMain("modelTest.responseLog", {
      output: result.outputText,
    }),
  });
  return {
    ok: true,
    message: tMain("settings.modelTestComplete", { output: result.outputText }),
    launchMode: resolveModelTestLaunchMode(
      options,
      result.launchTarget.launchMode,
    ),
    resolvedModelPath: result.launchTarget.modelPath ?? null,
    resolvedMmprojPath: result.launchTarget.mmprojPath ?? null,
    resolvedEndpoint: shouldExposeModelTestEndpoint(options)
      ? server.baseUrl
      : null,
  };
}

function resolveModelTestLaunchMode(
  options: TranslationOptions,
  gemmaLaunchMode: ModelTestResult["launchMode"],
): ModelTestResult["launchMode"] {
  if (options.modelProvider === "openai-codex") {
    return "openai-codex";
  }
  return options.modelProvider === "openai-api"
    ? "openai-api"
    : gemmaLaunchMode;
}

function shouldExposeModelTestEndpoint(options: TranslationOptions): boolean {
  return (
    options.modelProvider === "openai-codex" ||
    options.modelProvider === "openai-api"
  );
}

function handleModelTestFailure(
  error: unknown,
  settings: AppSettings,
  sendProgress: SendModelTestProgress,
  testId: string,
): ModelTestResult {
  const technicalError = formatModelTestError(error);
  const failureMessage = tMain("modelTest.failedDetail");
  logError("Settings model/runtime check failed", {
    testId,
    error: technicalError,
  });
  sendProgress({
    phase: "failed",
    progressText: tMain("modelTest.failed"),
    detail: failureMessage,
    installLogLine: tMain("modelTest.failedLog"),
  });
  return {
    ok: false,
    message: failureMessage,
    launchMode: resolveSettingsLaunchMode(settings),
  };
}

async function stopModelTestServer(
  runtime: SimplePageRuntime,
  server: ModelTestServer | null,
  endpointRuntime: ModelTestEndpointRuntime,
): Promise<void> {
  if (isCodexAppServerEndpoint(server)) {
    await endpointRuntime.stopCodexAppServerEndpoint(server);
  } else if (!isOpenAICompatibleApiEndpoint(server)) {
    await runtime.stopServer(server);
  }
}

function resolveModelTestId(providedTestId: unknown): string {
  if (
    typeof providedTestId === "string" &&
    providedTestId.length > 0 &&
    providedTestId.length <= MAX_MODEL_TEST_ID_LENGTH &&
    SAFE_MODEL_TEST_ID_PATTERN.test(providedTestId)
  ) {
    return providedTestId;
  }
  return randomUUID();
}

function resolveSettingsLaunchMode(
  settings: AppSettings,
): ModelTestResult["launchMode"] {
  if (settings.modelProvider === "openai-codex") {
    return "openai-codex";
  }
  if (settings.modelProvider === "openai-api") {
    return "openai-api";
  }
  return settings.gemma.modelSource === "local" ? "local" : "huggingface";
}

async function startModelTestServerWithRetry(
  runtime: SimplePageRuntime,
  initialOptions: TranslationOptions,
  sendProgress: SendModelTestProgress,
  endpointRuntime: ModelTestEndpointRuntime,
): Promise<{
  server: ModelTestServer;
  options: TranslationOptions;
}> {
  const initialSignal = initialOptions.abortSignal ?? undefined;
  throwIfAborted(initialSignal);
  if (initialOptions.modelProvider === "openai-api") {
    return {
      server: createOpenAICompatibleApiEndpoint(initialOptions),
      options: initialOptions,
    };
  }
  if (initialOptions.modelProvider === "openai-codex") {
    return {
      server: await endpointRuntime.startCodexAppServerEndpoint(initialOptions),
      options: initialOptions,
    };
  }

  let options = initialOptions;
  for (let attempt = 1; attempt <= MODEL_TEST_PORT_ATTEMPTS; attempt += 1) {
    try {
      throwIfAborted(options.abortSignal ?? undefined);
      const server = await runtime.startServer(options);
      return { server, options };
    } catch (error) {
      if (!isPortBindError(error) || attempt >= MODEL_TEST_PORT_ATTEMPTS) {
        throw error;
      }
      const nextPort = await reserveFreePort(options.abortSignal ?? undefined);
      throwIfAborted(options.abortSignal ?? undefined);
      options = { ...options, port: nextPort };
      sendProgress({
        phase: "booting",
        progressText: tMain("modelTest.portRetry"),
        detail: tMain("modelTest.portRetryDetail", { port: nextPort }),
        installLogLine: tMain("modelTest.portRetryLog", { port: nextPort }),
      });
    }
  }

  throw new Error(tMain("modelTest.portUnavailable"));
}

function isPortBindError(error: unknown): boolean {
  const text = formatModelTestError(error).toLowerCase();
  return (
    text.includes("eaddrinuse") ||
    text.includes("address already in use") ||
    text.includes("bind failed") ||
    text.includes("failed to bind") ||
    text.includes("only one usage of each socket address")
  );
}

function formatModelTestError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const details = [
    error.message,
    "recentStderr" in error &&
    typeof error.recentStderr === "string" &&
    error.recentStderr.trim()
      ? error.recentStderr.trim()
      : null,
    "rawTextPreview" in error &&
    typeof error.rawTextPreview === "string" &&
    error.rawTextPreview.trim()
      ? error.rawTextPreview.trim()
      : null,
  ].filter(Boolean);

  return details.join("\n\n");
}
