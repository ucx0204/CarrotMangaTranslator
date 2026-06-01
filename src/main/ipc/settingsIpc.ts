import { dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { AppSettingsSchema, parseIpcPayload } from "../../shared/ipcSchemas";
import type { AppSettings, LocalModelPickResult, ModelTestProgressEvent, ModelTestResult } from "../../shared/types";
import { buildBaseTranslationOptions } from "../appSettings";
import { startOpenAIOAuthEndpoint, stopOpenAIOAuthEndpoint, type OpenAIOAuthEndpoint } from "../openaiOauthEndpoint";
import { getAppSettings, resetAppSettings, saveAppSettings } from "../settingsStore";
import { isOpenAIOAuthEndpoint, type SimplePageRuntime } from "../simplePageRuntime";
import type { IpcContext } from "./context";

export function registerSettingsIpc(context: IpcContext): void {
  ipcMain.handle("settings:get", async () => getAppSettings());
  ipcMain.handle("settings:save", async (_event, settings: unknown) => saveAppSettings(parseIpcPayload(AppSettingsSchema, settings, "설정 저장")));
  ipcMain.handle("settings:reset", async () => resetAppSettings());
  ipcMain.handle("settings:pick-local-model", async (): Promise<LocalModelPickResult | null> => {
    const options = {
      title: "로컬 GGUF 모델 선택",
      properties: ["openFile"],
      filters: [{ name: "GGUF Model", extensions: ["gguf"] }]
    } satisfies Electron.OpenDialogOptions;
    const window = context.getMainWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    const modelPath = result.filePaths[0];
    const detectedMmprojPath = detectSiblingMmprojPath(modelPath);
    return {
      modelPath,
      ...(detectedMmprojPath ? { detectedMmprojPath } : {})
    };
  });
  ipcMain.handle("settings:pick-local-mmproj", async (): Promise<string | null> => {
    const options = {
      title: "mmproj 파일 선택",
      properties: ["openFile"],
      filters: [{ name: "GGUF Model", extensions: ["gguf"] }]
    } satisfies Electron.OpenDialogOptions;
    const window = context.getMainWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return result.filePaths[0];
  });
  ipcMain.handle("settings:test-model", async (event, rawSettings: unknown, _providedTestId?: string): Promise<ModelTestResult> => {
    const settings = parseIpcPayload(AppSettingsSchema, rawSettings, "모델 테스트");
    if (context.jobs.hasActive) {
      return {
        ok: false,
        message: "번역 작업 중에는 모델 테스트를 실행할 수 없습니다.",
        launchMode: resolveSettingsLaunchMode(settings)
      };
    }

    const runtime = context.loadSimplePageRuntime();
    const testId = randomUUID();
    const sendProgress = (progress: Omit<ModelTestProgressEvent, "id">) => {
      event.sender.send("settings:model-test-progress", {
        id: testId,
        ...progress
      } satisfies ModelTestProgressEvent);
    };
    const port = await reserveFreePort();
    const options = {
      ...buildBaseTranslationOptions({
        jobId: `settings-test-${testId}`,
        runDir: join(context.appPaths.dataRoot, "model-tests", testId),
        paths: context.appPaths,
        settings
      }),
      onProgress: (progress: Omit<ModelTestProgressEvent, "id">) => {
        sendProgress(progress);
      },
      reuseServer: false,
      port,
      label: `settings-test-${testId}`
    };

    let server: Awaited<ReturnType<SimplePageRuntime["startServer"]>> | OpenAIOAuthEndpoint | null = null;
    try {
      sendProgress({
        phase: "booting",
        progressText: "모델 테스트 준비 중",
        installLogLine: "모델 테스트를 시작합니다."
      });
      if (options.modelProvider === "openai-codex") {
        sendProgress({
          phase: "booting",
          progressText: "OpenAI Codex 엔드포인트 준비 중",
          detail: `${options.codexModel}, port ${options.codexOauthPort}`,
          installLogLine: "openai-oauth 엔드포인트를 시작합니다."
        });
      } else if (runtime.isModelCached(options)) {
        sendProgress({
          phase: "booting",
          progressText: "캐시된 Gemma 모델 확인됨",
          detail: options.modelFile,
          installLogLine: "캐시된 모델 파일을 사용합니다."
        });
      } else {
        sendProgress({
          phase: "model_downloading",
          progressText: "Gemma 모델 다운로드/서버 준비 중",
          detail: `${options.modelRepo} / ${options.modelFile}`,
          progressMode: "log-only",
          installLogLine: "캐시된 모델이 없어서 다운로드 또는 갱신을 시작합니다."
        });
      }
      server = options.modelProvider === "openai-codex" ? await startOpenAIOAuthEndpoint(options) : await runtime.startServer(options);
      sendProgress({
        phase: "ready",
        progressText: "서버 준비 완료",
        detail: server.baseUrl,
        installLogLine: `서버가 준비되었습니다: ${server.baseUrl}`
      });
      const result = await runtime.testModelReply(server, options);
      sendProgress({
        phase: "done",
        progressText: "모델 테스트 완료",
        detail: result.outputText,
        installLogLine: `응답 확인 완료: ${result.outputText}`
      });
      return {
        ok: true,
        message: `모델 로드 및 텍스트 응답 확인 완료: ${result.outputText}`,
        launchMode: options.modelProvider === "openai-codex" ? "openai-codex" : result.launchTarget.launchMode,
        resolvedModelPath: result.launchTarget.modelPath ?? null,
        resolvedMmprojPath: result.launchTarget.mmprojPath ?? null,
        resolvedEndpoint: options.modelProvider === "openai-codex" ? server.baseUrl : null
      };
    } catch (error) {
      sendProgress({
        phase: "failed",
        progressText: "모델 테스트 실패",
        detail: formatModelTestError(error),
        installLogLine: "모델 테스트가 실패했습니다."
      });
      return {
        ok: false,
        message: formatModelTestError(error),
        launchMode: resolveSettingsLaunchMode(settings)
      };
    } finally {
      if (isOpenAIOAuthEndpoint(server)) {
        await stopOpenAIOAuthEndpoint(server);
      } else {
        await runtime.stopServer(server);
      }
    }
  });
}

function detectSiblingMmprojPath(modelPath: string): string | null {
  const folder = dirname(modelPath);
  if (!existsSync(folder)) {
    return null;
  }

  const preferredNames = ["mmproj-BF16.gguf", "mmproj-F16.gguf", "mmproj-F32.gguf", "mmproj.gguf"];
  for (const name of preferredNames) {
    const candidate = join(folder, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const match = readdirSync(folder, { withFileTypes: true }).find(
    (entry) => entry.isFile() && /^mmproj.*\.gguf$/i.test(entry.name)
  );
  return match ? join(folder, match.name) : null;
}

function resolveSettingsLaunchMode(settings: AppSettings): ModelTestResult["launchMode"] {
  if (settings.modelProvider === "openai-codex") {
    return "openai-codex";
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

function formatModelTestError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const details = [
    error.message,
    "recentStderr" in error && typeof error.recentStderr === "string" && error.recentStderr.trim()
      ? error.recentStderr.trim()
      : null,
    "rawTextPreview" in error && typeof error.rawTextPreview === "string" && error.rawTextPreview.trim()
      ? error.rawTextPreview.trim()
      : null
  ].filter(Boolean);

  return details.join("\n\n");
}
