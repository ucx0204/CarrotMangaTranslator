import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSettings, ModelTestProgressEvent } from "../src/shared/types";
import type { IpcContext } from "../src/main/ipc/context";
import type { SimplePageRuntime } from "../src/main/simplePageRuntime";

type IpcHandler = (
  event: { sender: { id: number; send: (channel: string, payload: unknown) => void } },
  ...args: unknown[]
) => Promise<unknown> | unknown;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    showOpenDialog: vi.fn()
  };
});

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => ""
  },
  dialog: {
    showOpenDialog: electronMock.showOpenDialog
  },
  ipcMain: {
    handle: electronMock.handle
  }
}));

import { registerSettingsIpc } from "../src/main/ipc/settingsIpc";

const tempDirs: string[] = [];

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.handle.mockClear();
  electronMock.showOpenDialog.mockClear();
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
      installLogLine: "Gemma runtime preparation log"
    } satisfies Omit<ModelTestProgressEvent, "id">;
    const runtime = createRuntime({
      cached: false,
      startProgress: runtimeProgress
    });

    const { result, progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createGemmaSettings(),
      testId: providedTestId
    });

    expect(result).toMatchObject({
      ok: true,
      message: "Paddle OCR과 번역 엔진 확인 완료: model test ok",
      launchMode: "cached-hf"
    });
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents.every((event) => event.id === providedTestId)).toBe(true);
    expect(progressEvents.map((event) => event.progressText)).toContain("Paddle OCR 확인 완료");
    expect(progressEvents.map((event) => event.installLogLine)).toContain(runtimeProgress.installLogLine);
    expect(runtime.ensurePaddleOcrRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.stopServer).toHaveBeenCalledTimes(1);
  });

  it("falls back to an internal id when the renderer id is too long", async () => {
    const providedTestId = "x".repeat(201);
    const runtime = createRuntime({
      cached: true
    });

    const { progressEvents } = await invokeSettingsModelTest({
      runtime,
      settings: createGemmaSettings(),
      testId: providedTestId
    });

    const eventIds = new Set(progressEvents.map((event) => event.id));
    expect(eventIds.size).toBe(1);
    expect([...eventIds][0]).not.toBe(providedTestId);
    expect([...eventIds][0]).toHaveLength(36);
  });
});

async function invokeSettingsModelTest({
  runtime,
  settings,
  testId
}: {
  runtime: SimplePageRuntime;
  settings: AppSettings;
  testId: string;
}): Promise<{ result: Record<string, unknown>; progressEvents: ModelTestProgressEvent[] }> {
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
        }
      }
    },
    settings,
    testId
  );

  return {
    result: result as Record<string, unknown>,
    progressEvents
  };
}

function createContext(dataRoot: string, runtime: SimplePageRuntime): IpcContext {
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
      llamaServerPath: join(dataRoot, "tools", "llama-server")
    },
    jobs: {
      hasActive: false
    } as IpcContext["jobs"],
    getMainWindow: () =>
      ({
        isDestroyed: () => false,
        webContents: { id: 1 }
      }) as ReturnType<IpcContext["getMainWindow"]>,
    loadSimplePageRuntime: () => runtime,
    decodeImage: vi.fn()
  };
}

function createRuntime({
  cached,
  startProgress
}: {
  cached: boolean;
  startProgress?: Omit<ModelTestProgressEvent, "id">;
}): SimplePageRuntime {
  return {
    isModelCached: vi.fn(() => cached),
    ensurePaddleOcrRuntime: vi.fn(async () => ({
      runtimeVariant: "cpu",
      pythonPath: "C:\\python\\python.exe",
      prepared: true
    })),
    startServer: vi.fn(async (options) => {
      if (startProgress) {
        (options.onProgress as ((progress: Omit<ModelTestProgressEvent, "id">) => void) | undefined)?.(startProgress);
      }
      return {
        baseUrl: "http://127.0.0.1:18180/v1",
        child: null,
        startedByScript: true
      };
    }),
    stopServer: vi.fn(async () => {}),
    testModelReply: vi.fn(async () => ({
      outputText: "model test ok",
      launchTarget: {
        launchMode: "cached-hf" as const,
        modelPath: "C:\\models\\gemma.gguf",
        mmprojPath: "C:\\models\\mmproj.gguf"
      }
    }))
  };
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
      vramMode: "economy"
    },
    codex: {
      model: "gpt-5.5",
      reasoningEffort: "low",
      oauthPort: 10531
    },
    ocr: {
      device: "cpu",
      gpuCudaTag: "cu126"
    },
    maxTokens: 12000
  };
}
