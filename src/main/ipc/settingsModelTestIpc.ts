import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { AppSettingsSchema, parseIpcPayload } from "../../shared/ipcSchemas";
import type { ModelTestResult } from "../../shared/jobTypes";
import type { AppSettings } from "../../shared/settingsTypes";
import {
  buildBaseTranslationOptions,
  type TranslationOptions,
} from "../appSettings";
import { logError } from "../logger";
import {
  startOpenAIOAuthEndpoint,
  stopOpenAIOAuthEndpoint,
  type OpenAIOAuthEndpoint,
} from "../openaiOauthEndpoint";
import {
  createOpenAICompatibleApiEndpoint,
  isOpenAICompatibleApiEndpoint,
  type OpenAICompatibleApiEndpoint,
} from "../openaiApiEndpoint";
import {
  isOpenAIOAuthEndpoint,
  type SimplePageRuntime,
} from "../simplePageRuntime";
import type { IpcContext } from "./context";
import {
  createModelTestProgressSender,
  sendEnginePreparationProgress,
  verifyPaddleOcrRuntime,
  type SendModelTestProgress,
} from "./settingsModelTestProgress";

const MAX_MODEL_TEST_ID_LENGTH = 200;
const SAFE_MODEL_TEST_ID_PATTERN = /^(?=.*[A-Za-z0-9_-])[A-Za-z0-9._-]+$/;
const MODEL_TEST_PORT_ATTEMPTS = 4;

type ModelTestServer =
  | Awaited<ReturnType<SimplePageRuntime["startServer"]>>
  | OpenAIOAuthEndpoint
  | OpenAICompatibleApiEndpoint;

type ModelTestRunInput = {
  options: TranslationOptions;
  runtime: SimplePageRuntime;
  sendProgress: SendModelTestProgress;
  settings: AppSettings;
  testId: string;
};

export async function handleModelSettingsTest(
  context: IpcContext,
  event: Electron.IpcMainInvokeEvent,
  rawSettings: unknown,
  providedTestId: unknown,
): Promise<ModelTestResult> {
  const settings = parseIpcPayload(
    AppSettingsSchema,
    rawSettings,
    "모델/런타임 확인",
  );
  if (context.jobs.hasActive) {
    return buildBusyModelTestResult(settings);
  }

  const testId = resolveModelTestId(providedTestId);
  return runModelTestWithServer({
    options: await buildInitialModelTestOptions(context, settings, testId),
    runtime: context.loadSimplePageRuntime(),
    sendProgress: createModelTestProgressSender(event, testId),
    settings,
    testId,
  });
}

function buildBusyModelTestResult(settings: AppSettings): ModelTestResult {
  return {
    ok: false,
    message: "번역 작업 중에는 모델/런타임 확인을 실행할 수 없습니다.",
    launchMode: resolveSettingsLaunchMode(settings),
  };
}

async function buildInitialModelTestOptions(
  context: IpcContext,
  settings: AppSettings,
  testId: string,
): Promise<TranslationOptions> {
  const port = await reserveFreePort();
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
    codexOauthPort: port,
    label: `settings-test-${testId}`,
  };
}

function createNoopProgressBridge(): TranslationOptions["onProgress"] {
  return undefined;
}

async function runModelTestWithServer({
  options: initialOptions,
  runtime,
  sendProgress,
  settings,
  testId,
}: ModelTestRunInput): Promise<ModelTestResult> {
  let server: ModelTestServer | null = null;
  try {
    sendModelTestBootProgress(sendProgress);
    const options = withModelTestProgress(initialOptions, sendProgress);
    await verifyPaddleOcrRuntime(runtime, options, sendProgress);
    sendEnginePreparationProgress(runtime, options, sendProgress);
    const started = await startModelTestServerWithRetry(
      runtime,
      options,
      sendProgress,
    );
    server = started.server;
    return await finishModelRuntimeTest(
      runtime,
      started.options,
      server,
      sendProgress,
    );
  } catch (error) {
    return handleModelTestFailure(error, settings, sendProgress, testId);
  } finally {
    await stopModelTestServer(runtime, server);
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
    progressText: "모델/런타임 확인 준비 중",
    installLogLine: "Paddle OCR과 번역 엔진 확인을 시작합니다.",
  });
}

async function finishModelRuntimeTest(
  runtime: SimplePageRuntime,
  options: TranslationOptions,
  server: ModelTestServer,
  sendProgress: SendModelTestProgress,
): Promise<ModelTestResult> {
  sendProgress({
    phase: "ready",
    progressText: "런타임 서버 준비 완료",
    detail: server.baseUrl,
    installLogLine: `서버가 준비되었습니다: ${server.baseUrl}`,
  });
  const result = await runtime.testModelReply(server, options);
  sendProgress({
    phase: "done",
    progressText: "모델/런타임 확인 완료",
    detail: result.outputText,
    installLogLine: `응답 확인 완료: ${result.outputText}`,
  });
  return {
    ok: true,
    message: `Paddle OCR과 번역 엔진 확인 완료: ${result.outputText}`,
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
  logError("Settings model/runtime check failed", {
    testId,
    error: formatModelTestError(error),
  });
  sendProgress({
    phase: "failed",
    progressText: "모델/런타임 확인 실패",
    detail: formatModelTestError(error),
    installLogLine: "모델/런타임 확인이 실패했습니다.",
  });
  return {
    ok: false,
    message: formatModelTestError(error),
    launchMode: resolveSettingsLaunchMode(settings),
  };
}

async function stopModelTestServer(
  runtime: SimplePageRuntime,
  server: ModelTestServer | null,
): Promise<void> {
  if (isOpenAIOAuthEndpoint(server)) {
    await stopOpenAIOAuthEndpoint(server);
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

async function reserveFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("모델 테스트용 포트를 확보하지 못했습니다."));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function startModelTestServerWithRetry(
  runtime: SimplePageRuntime,
  initialOptions: TranslationOptions,
  sendProgress: SendModelTestProgress,
): Promise<{
  server: ModelTestServer;
  options: TranslationOptions;
}> {
  if (initialOptions.modelProvider === "openai-api") {
    return {
      server: createOpenAICompatibleApiEndpoint(initialOptions),
      options: initialOptions,
    };
  }

  let options = initialOptions;
  for (let attempt = 1; attempt <= MODEL_TEST_PORT_ATTEMPTS; attempt += 1) {
    try {
      const server =
        options.modelProvider === "openai-codex"
          ? await startOpenAIOAuthEndpoint(options)
          : await runtime.startServer(options);
      return { server, options };
    } catch (error) {
      if (!isPortBindError(error) || attempt >= MODEL_TEST_PORT_ATTEMPTS) {
        throw error;
      }
      const nextPort = await reserveFreePort();
      options = { ...options, port: nextPort, codexOauthPort: nextPort };
      sendProgress({
        phase: "booting",
        progressText: "모델/런타임 확인 포트 재시도 중",
        detail: `이전 포트가 이미 사용 중이라 ${nextPort}번 포트로 다시 시작합니다.`,
        installLogLine: `모델 테스트 포트 충돌을 감지해 ${nextPort}번 포트로 재시도합니다.`,
      });
    }
  }

  throw new Error("모델 테스트용 포트를 확보하지 못했습니다.");
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
