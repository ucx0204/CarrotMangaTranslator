import { describe, expect, it, vi } from "vitest";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import type { IpcContext } from "../src/main/ipc/context";
import { handleModelSettingsTest } from "../src/main/ipc/settingsModelTestIpc";
import { reserveFreePort } from "../src/main/ipc/settingsModelTestPort";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type { SimplePageRuntime } from "../src/main/simplePageRuntime";
import type { AppSettings } from "../src/shared/settingsTypes";

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

describe("model test managed operation lifecycle", () => {
  it("blocks a second model test before runtime preparation starts", async () => {
    const verifyGate = createDeferred<{
      runtimeVariant: string;
      pythonPath: string;
      prepared: boolean;
    }>();
    const runtime = createRuntime();
    runtime.ensurePaddleOcrRuntime = vi.fn(() => verifyGate.promise);
    const context = createContext(runtime);

    const first = handleModelSettingsTest(
      context,
      createEvent(),
      createGemmaSettings(),
      "first-test",
    );
    await vi.waitFor(() => {
      expect(runtime.ensurePaddleOcrRuntime).toHaveBeenCalledTimes(1);
    });
    expect(context.operations.current?.kind).toBe("model-test");

    const second = await handleModelSettingsTest(
      context,
      createEvent(),
      createGemmaSettings(),
      "second-test",
    );
    expect(second.ok).toBe(false);
    expect(runtime.ensurePaddleOcrRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.startServer).not.toHaveBeenCalled();

    verifyGate.resolve({
      runtimeVariant: "cpu",
      pythonPath: "C:\\python\\python.exe",
      prepared: true,
    });
    await first;
    expect(context.operations.current).toBeNull();
  });

  it("blocks model testing while a job is active", async () => {
    const runtime = createRuntime();
    const context = createContext(runtime);
    context.jobs.start({
      id: "translation-active",
      kind: "gemma-analysis",
      abortController: new AbortController(),
    });

    const result = await handleModelSettingsTest(
      context,
      createEvent(),
      createGemmaSettings(),
      "blocked-by-job",
    );

    expect(result.ok).toBe(false);
    expect(runtime.ensurePaddleOcrRuntime).not.toHaveBeenCalled();
    expect(context.operations.current).toBeNull();
    context.jobs.clearIfCurrent("translation-active");
  });

  it("blocks new jobs while a model test operation is active", async () => {
    const verifyGate = createDeferred<{
      runtimeVariant: string;
      pythonPath: string;
      prepared: boolean;
    }>();
    const runtime = createRuntime();
    runtime.ensurePaddleOcrRuntime = vi.fn(() => verifyGate.promise);
    const context = createContext(runtime);

    const testing = handleModelSettingsTest(
      context,
      createEvent(),
      createGemmaSettings(),
      "model-test-active",
    );
    await vi.waitFor(() => {
      expect(runtime.ensurePaddleOcrRuntime).toHaveBeenCalledTimes(1);
    });

    expect(() =>
      context.jobs.start({
        id: "late-page-export",
        kind: "page-export",
        abortController: new AbortController(),
      }),
    ).toThrow("이미 실행 중인 작업이 있습니다.");

    verifyGate.resolve({
      runtimeVariant: "cpu",
      pythonPath: "C:\\python\\python.exe",
      prepared: true,
    });
    await testing;
  });

  it("keeps the operation alive through server stop after app-quit abort", async () => {
    const runtime = createRuntime();
    let replySignal: AbortSignal | undefined;
    runtime.testModelReply = vi.fn(async (_server, options) => {
      replySignal = options.abortSignal ?? undefined;
      return await new Promise<never>((_resolve, reject) => {
        const rejectAbort = () =>
          reject(
            replySignal?.reason instanceof Error
              ? replySignal.reason
              : new DOMException("Aborted", "AbortError"),
          );
        replySignal?.addEventListener("abort", rejectAbort, { once: true });
        if (replySignal?.aborted) {
          rejectAbort();
        }
      });
    });
    const stopGate = createDeferred<void>();
    runtime.stopServer = vi.fn(() => stopGate.promise);
    const context = createContext(runtime);

    const testing = handleModelSettingsTest(
      context,
      createEvent(),
      createGemmaSettings(),
      "quit-abort-test",
    );
    await vi.waitFor(() => {
      expect(runtime.testModelReply).toHaveBeenCalledTimes(1);
    });

    let quitWaitSettled = false;
    const quitWait = context.operations
      .abortCurrentAndWait("app-quit")
      .then((value) => {
        quitWaitSettled = true;
        return value;
      });
    await vi.waitFor(() => {
      expect(replySignal?.aborted).toBe(true);
      expect(runtime.stopServer).toHaveBeenCalledTimes(1);
    });
    expect(quitWaitSettled).toBe(false);
    expect(context.operations.current?.kind).toBe("model-test");

    stopGate.resolve(undefined);
    await expect(quitWait).resolves.toMatchObject({ kind: "model-test" });
    await testing;
    expect(quitWaitSettled).toBe(true);
    expect(context.operations.current).toBeNull();
  });

  it("can abort free-port reservation before or during listen without leaving it pending", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new DOMException("cancel port", "AbortError"));
    await expect(reserveFreePort(alreadyAborted.signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    const listeningAbort = new AbortController();
    const pendingReservation = reserveFreePort(listeningAbort.signal);
    listeningAbort.abort(new DOMException("cancel pending port", "AbortError"));
    await expect(pendingReservation).rejects.toMatchObject({
      name: "AbortError",
    });

    await expect(reserveFreePort()).resolves.toBeGreaterThan(0);
  });
});

function createContext(runtime: SimplePageRuntime): IpcContext {
  const activityGate = new AppActivityGate();
  return {
    appPaths: {
      isPackaged: false,
      repoRoot: "C:\\test",
      executableDir: "C:\\test",
      resourcesDir: "C:\\test\\resources",
      dataRoot: "C:\\test\\data",
      settingsPath: "C:\\test\\data\\settings.json",
      libraryDir: "C:\\test\\data\\library",
      fontsDir: "C:\\test\\data\\fonts",
      logsDir: "C:\\test\\data\\logs",
      logFile: "C:\\test\\data\\logs\\app.log",
      runtimeDir: "C:\\test\\runtime",
      toolsDir: "C:\\test\\tools",
      ocrRuntimeDir: "C:\\test\\ocr",
      llamaRuntimeDir: "C:\\test\\llama",
      llamaServerPath: "C:\\test\\llama\\server.exe",
    },
    jobs: new ActiveJobStore(undefined, activityGate),
    operations: new AppOperationRegistry(activityGate),
    getMainWindow: () => null,
    panelWindows: {
      close: () => false,
      closeAll: () => undefined,
      getLastState: () => null,
      getOpenPanelIds: () => [],
      isPanelSender: () => false,
      open: () => false,
      publishState: () => undefined,
    },
    loadSimplePageRuntime: () => runtime,
    decodeImage: async () => null,
  };
}

function createEvent(): Parameters<typeof handleModelSettingsTest>[1] {
  return {
    sender: {
      send: vi.fn(),
    },
  };
}

function createRuntime(): SimplePageRuntime {
  return {
    isModelCached: vi.fn(() => true),
    ensurePaddleOcrRuntime: vi.fn(async () => ({
      runtimeVariant: "cpu",
      pythonPath: "C:\\python\\python.exe",
      prepared: true,
    })),
    startServer: vi.fn(async () => ({
      baseUrl: "http://127.0.0.1:18180/v1",
      child: null,
      startedByScript: true,
    })),
    stopServer: vi.fn(async () => undefined),
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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
