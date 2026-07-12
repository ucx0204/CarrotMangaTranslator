import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSettings } from "../src/shared/settingsTypes";
import type { ModelTestProgressEvent } from "../src/shared/jobTypes";
import type { IpcContext } from "../src/main/ipc/context";
import type { SimplePageRuntime } from "../src/main/simplePageRuntime";

type IpcHandler = (
  event: {
    sender: { id: number; send: (channel: string, payload: unknown) => void };
    senderFrame?: { url: string };
  },
  ...args: unknown[]
) => Promise<unknown> | unknown;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    showOpenDialog: vi.fn(),
  };
});

const oauthMock = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async () => {}),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "",
  },
  dialog: {
    showOpenDialog: electronMock.showOpenDialog,
  },
  ipcMain: {
    handle: electronMock.handle,
  },
}));

vi.mock("../src/main/openaiOauthEndpoint", () => ({
  startOpenAIOAuthEndpoint: oauthMock.start,
  stopOpenAIOAuthEndpoint: oauthMock.stop,
}));

import { registerSettingsIpc } from "../src/main/ipc/settingsIpc";

const tempDirs: string[] = [];

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.showOpenDialog.mockClear();
  oauthMock.start.mockReset();
  oauthMock.stop.mockReset();
  oauthMock.stop.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("settings IPC model/runtime check", () => {
  it("uses the renderer-provided test id for progress events", async () => {
    const providedTestId = "settings-test-renderer-id";
    const runtimeProgress = {
      phase: "model_downloading",
      progressText: "Gemma 실행 런타임 다운로드 중",
      detail: "runtime.zip",
      progressMode: "log-only",
      installLogLine: "Gemma runtime preparation log",
    } satisfies Omit<ModelTestProgressEvent, "id">;
    const runtime = createRuntime({
      cached: false,
      startProgress: runtimeProgress,
    });

    const { result, progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createGemmaSettings(),
      testId: providedTestId,
    });

    expect(result).toMatchObject({
      ok: true,
      message: "Paddle OCR과 번역 엔진 확인 완료: model test ok",
      launchMode: "cached-hf",
    });
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents.every((event) => event.id === providedTestId)).toBe(
      true,
    );
    expect(progressEvents.map((event) => event.progressText)).toContain(
      "Paddle OCR 확인 완료",
    );
    expect(progressEvents.map((event) => event.installLogLine)).toContain(
      runtimeProgress.installLogLine,
    );
    expect(runtime.ensurePaddleOcrRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.stopServer).toHaveBeenCalledTimes(1);
  });

  it("falls back to an internal id when the renderer id is too long", async () => {
    const providedTestId = "x".repeat(201);
    const runtime = createRuntime({
      cached: true,
    });

    const { progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createGemmaSettings(),
      testId: providedTestId,
    });

    const eventIds = new Set(progressEvents.map((event) => event.id));
    expect(eventIds.size).toBe(1);
    expect([...eventIds][0]).not.toBe(providedTestId);
    expect([...eventIds][0]).toHaveLength(36);
  });

  it("retries Gemma model tests when the reserved port is taken before startup", async () => {
    const runtime = createRuntime({
      cached: true,
      startErrors: [portBindError()],
    });

    const { result, progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createGemmaSettings(),
      testId: "retry-gemma-port",
    });

    expect(result.ok).toBe(true);
    expect(runtime.startServer).toHaveBeenCalledTimes(2);
    expect(progressEvents.map((event) => event.progressText)).toContain(
      "모델/런타임 확인 포트 재시도 중",
    );
    expect(runtime.stopServer).toHaveBeenCalledTimes(1);
  });

  it("retries OpenAI Codex model test endpoints with a fresh temporary port", async () => {
    const endpoint = {
      baseUrl: "http://127.0.0.1:18080/v1",
      child: null,
      startedByScript: true,
      provider: "openai-codex",
      oauthServer: {},
    };
    oauthMock.start
      .mockRejectedValueOnce(portBindError())
      .mockResolvedValueOnce(endpoint);
    const runtime = createRuntime({
      cached: true,
    });

    const { result, progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createCodexSettings(),
      testId: "retry-codex-port",
    });

    expect(result).toMatchObject({
      ok: true,
      launchMode: "openai-codex",
      resolvedEndpoint: endpoint.baseUrl,
    });
    expect(oauthMock.start).toHaveBeenCalledTimes(2);
    const firstOptions = oauthMock.start.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const secondOptions = oauthMock.start.mock.calls[1]?.[0] as Record<
      string,
      unknown
    >;
    expect(firstOptions.codexOauthPort).toBe(firstOptions.port);
    expect(secondOptions.codexOauthPort).toBe(secondOptions.port);
    expect(progressEvents.map((event) => event.progressText)).toContain(
      "모델/런타임 확인 포트 재시도 중",
    );
    expect(oauthMock.stop).toHaveBeenCalledWith(endpoint);
  });

  it("tests API settings through the direct compatible endpoint", async () => {
    const runtime = createRuntime({
      cached: true,
    });

    const { result, progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createApiSettings(),
      testId: "api-direct",
    });

    expect(result).toMatchObject({
      ok: true,
      launchMode: "openai-api",
      resolvedEndpoint: "http://127.0.0.1:1234/v1",
    });
    expect(runtime.startServer).not.toHaveBeenCalled();
    expect(runtime.stopServer).not.toHaveBeenCalled();
    expect(oauthMock.start).not.toHaveBeenCalled();
    expect(oauthMock.stop).not.toHaveBeenCalled();
    expect(runtime.testModelReply).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:1234/v1",
        provider: "openai-api",
      }),
      expect.objectContaining({
        modelProvider: "openai-api",
        apiModel: "local-vision-model",
      }),
    );
    expect(progressEvents.map((event) => event.progressText)).toContain(
      "API 엔드포인트 확인 중",
    );
  });

  it("shows a localized failure summary while keeping raw errors out of the UI payload", async () => {
    const runtime = createRuntime({
      cached: true,
      startErrors: [new Error("raw runtime failure")],
    });

    const { result, progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createGemmaSettings(),
      testId: "localized-failure",
    });

    const expected =
      "모델/런타임 확인에 실패했습니다. 자세한 원인은 로그에서 확인하세요.";
    expect(result).toMatchObject({ ok: false, message: expected });
    expect(
      progressEvents.find((event) => event.phase === "failed")?.detail,
    ).toBe(expected);
    expect(JSON.stringify({ result, progressEvents })).not.toContain(
      "raw runtime failure",
    );
  });
});

async function invokeSettingsModelTest({
  runtime,
  settings,
  testId,
}: {
  runtime: SimplePageRuntime;
  settings: AppSettings;
  testId: string;
}): Promise<{
  result: Record<string, unknown>;
  progressEvents: ModelTestProgressEvent[];
}> {
  const dataRoot = mkdtempSync(join(tmpdir(), "settings-ipc-"));
  tempDirs.push(dataRoot);
  const context = createContext(dataRoot, runtime);
  registerSettingsIpc(context);
  const handler = electronMock.handlers.get("settings:test-model");
  if (!handler) {
    throw new Error("settings:test-model handler was not registered");
  }

  const progressEvents: ModelTestProgressEvent[] = [];
  const result = await handler(
    {
      sender: {
        id: 1,
        send: (channel, payload) => {
          if (channel === "settings:model-test-progress") {
            progressEvents.push(payload as ModelTestProgressEvent);
          }
        },
      },
      senderFrame: { url: "http://127.0.0.1:5173/" },
    },
    settings,
    testId,
  );

  return {
    result: result as Record<string, unknown>,
    progressEvents,
  };
}

function createContext(
  dataRoot: string,
  runtime: SimplePageRuntime,
): IpcContext {
  return {
    appPaths: {
      isPackaged: false,
      repoRoot: dataRoot,
      executableDir: dataRoot,
      resourcesDir: dataRoot,
      dataRoot,
      settingsPath: join(dataRoot, "settings.json"),
      libraryDir: join(dataRoot, "library"),
      fontsDir: join(dataRoot, "fonts"),
      logsDir: join(dataRoot, "logs"),
      logFile: join(dataRoot, "logs", "app.log"),
      runtimeDir: join(dataRoot, "runtime"),
      toolsDir: join(dataRoot, "tools"),
      ocrRuntimeDir: join(dataRoot, "ocr-runtime"),
      llamaRuntimeDir: join(dataRoot, "tools"),
      llamaServerPath: join(dataRoot, "tools", "llama-server"),
    },
    jobs: {
      hasActive: false,
    } as IpcContext["jobs"],
    getMainWindow: () =>
      ({
        isDestroyed: () => false,
        webContents: { id: 1, getURL: () => "http://127.0.0.1:5173/" },
      }) as ReturnType<IpcContext["getMainWindow"]>,
    panelWindows: {
      open: () => true,
      close: () => true,
      publishState: () => undefined,
      getOpenPanelIds: () => [],
      getLastState: () => null,
      isPanelSender: () => false,
      closeAll: () => undefined,
    } as unknown as IpcContext["panelWindows"],
    loadSimplePageRuntime: () => runtime,
    decodeImage: vi.fn(),
  };
}

function createRuntime({
  cached,
  startProgress,
  startErrors = [],
}: {
  cached: boolean;
  startProgress?: Omit<ModelTestProgressEvent, "id">;
  startErrors?: unknown[];
}): SimplePageRuntime {
  const pendingStartErrors = [...startErrors];
  return {
    isModelCached: vi.fn(() => cached),
    ensurePaddleOcrRuntime: vi.fn(async () => ({
      runtimeVariant: "cpu",
      pythonPath: "C:\\python\\python.exe",
      prepared: true,
    })),
    startServer: vi.fn(async (options) => {
      const startError = pendingStartErrors.shift();
      if (startError) {
        throw startError;
      }
      if (startProgress) {
        (
          options.onProgress as
            | ((progress: Omit<ModelTestProgressEvent, "id">) => void)
            | undefined
        )?.(startProgress);
      }
      return {
        baseUrl: "http://127.0.0.1:18180/v1",
        child: null,
        startedByScript: true,
      };
    }),
    stopServer: vi.fn(async () => {}),
    testModelReply: vi.fn(async () => ({
      outputText: "model test ok",
      launchTarget: {
        launchMode: "cached-hf" as const,
        modelPath: "C:\\models\\gemma.gguf",
        mmprojPath: "C:\\models\\mmproj.gguf",
      },
    })),
  };
}

function portBindError(): Error {
  return Object.assign(new Error("EADDRINUSE: address already in use"), {
    code: "EADDRINUSE",
  });
}

function createGemmaSettings(): AppSettings {
  return {
    modelProvider: "gemma",
    gemma: {
      modelSource: "huggingface",
      modelRepo: "example/gemma",
      modelFile: "gemma.gguf",
      mmprojRepo: "example/gemma-mmproj",
      mmprojFile: "mmproj.gguf",
      vramMode: "economy26b",
    },
    codex: {
      model: "gpt-5.5",
      reasoningEffort: "low",
      oauthPort: 10531,
    },
    api: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.5",
    },
    ocr: {
      device: "cpu",
      qualityMode: "economy",
      gpuCudaTag: "cu126",
    },
    maxTokens: 12000,
    ctx: 16384,
  };
}

function createCodexSettings(): AppSettings {
  return {
    ...createGemmaSettings(),
    modelProvider: "openai-codex",
    codex: {
      model: "gpt-5.5",
      reasoningEffort: "low",
      oauthPort: 10531,
    },
  };
}

function createApiSettings(): AppSettings {
  return {
    ...createGemmaSettings(),
    modelProvider: "openai-api",
    api: {
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-vision-model",
      apiKey: "sk-test",
    },
  };
}
