import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";

const { createOcrBatchConfig } =
  require("../src/main/runtime/ocr/bbox-batch-config.cjs") as {
    createOcrBatchConfig: (dependencies: {
      os: {
        cpus: () => unknown[];
        platform: () => NodeJS.Platform;
        freemem: () => number;
        totalmem: () => number;
      };
      runtimeOverrideEnv: () => undefined;
      isHayaiOcrPipeline: (options?: Record<string, unknown>) => boolean;
      readPositiveInteger: (value: unknown) => number | null;
      emitRuntimeProgress: () => void;
      resolveOcrEngineLabel: () => string;
    }) => {
      hasOcrCpuWorkerRamHeadroom: (
        info: { freeRatio: number } | null,
        minFreeRatio: number,
      ) => boolean;
      resolveOcrCpuWorkerCount: (
        options: { ocrCpuWorkers?: number },
        pageCount: number,
      ) => number;
      resolveOcrCpuWorkerMinFreeRamRatio: (options?: {
        ocrCpuWorkerMinFreeRamPercent?: number;
      }) => number;
      waitForOcrCpuWorkerRamHeadroom: (
        options?: Record<string, unknown>,
        chunkIndex?: number,
      ) => Promise<void>;
      delayForOcrWorkerStart: (
        milliseconds: number,
        signal?: AbortSignal,
      ) => Promise<void>;
      resolveOcrWorkerThreadCount: (
        options?: Record<string, unknown>,
      ) => number;
      resolveOcrCpuWorkerStartDelayMs: (
        options?: Record<string, unknown>,
      ) => number;
    };
  };

function createConfig(
  platform: NodeJS.Platform,
  freeRatio = () => 0.5,
  progress = () => undefined,
) {
  return createOcrBatchConfig({
    os: {
      cpus: () => Array.from({ length: 8 }, () => ({})),
      platform: () => platform,
      freemem: () => 1000 * freeRatio(),
      totalmem: () => 1000,
    },
    runtimeOverrideEnv: () => undefined,
    isHayaiOcrPipeline: (options) => options?.ocrPipeline === "hayai",
    readPositiveInteger: (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    },
    emitRuntimeProgress: progress,
    resolveOcrEngineLabel: () => "HayaiOCR",
  });
}

const { createOcrCpuWorkers } =
  require("../src/main/runtime/ocr/bbox-cpu-workers.cjs") as {
    createOcrCpuWorkers: (dependencies: Record<string, unknown>) => {
      collectOcrBboxHintsBatchInCpuWorkers: (
        context: Record<string, unknown>,
      ) => Promise<unknown[]>;
    };
  };

afterEach(() => {
  vi.useRealTimers();
});

describe("OCR CPU worker failure during RAM admission", () => {
  it("propagates the original worker failure after cleanup without waiting for RAM recovery", async () => {
    vi.useFakeTimers();
    const harness = makeCpuWorkerHarness();
    const worker = workerDeferred<{ stdout: string; stderr: string }>();
    const cleanup = workerDeferred<void>();
    harness.run.mockImplementationOnce(() => worker.promise);
    harness.cleanup.mockImplementationOnce(() => cleanup.promise);
    const failure = new Error("first OCR worker failed");
    const outcome = { settled: false, error: undefined as unknown };
    const running = harness.collect().then(
      () => {
        outcome.settled = true;
      },
      (error: unknown) => {
        outcome.settled = true;
        outcome.error = error;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.run).toHaveBeenCalledTimes(1);
      expect(harness.progress).toHaveBeenCalled();
      worker.reject(failure);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.cleanup).toHaveBeenCalledTimes(1);
      expect(outcome.settled).toBe(false);
      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect({ ...outcome }).toEqual({ settled: true, error: failure });
      expect(harness.run).toHaveBeenCalledTimes(1);
      expect(harness.stopPoller).toHaveBeenCalledTimes(1);
      expect(harness.controller.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cleanup.resolve();
      worker.reject(failure);
      harness.controller.abort();
      await running;
    }
  });

  it("keeps a healthy batch waiting until RAM recovers", async () => {
    vi.useFakeTimers();
    const harness = makeCpuWorkerHarness();
    let settled = false;
    const running = harness.collect().finally(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(harness.run).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      harness.ram.freeRatio = 0.5;
      await vi.advanceTimersByTimeAsync(100);
      await expect(running).resolves.toHaveLength(2);
      expect(harness.run).toHaveBeenCalledTimes(2);
      expect(harness.cleanup).toHaveBeenCalledTimes(2);
    } finally {
      harness.controller.abort();
      await running.catch((error: unknown) => {
        expect(error).toMatchObject({ name: "AbortError" });
      });
    }
  });

  it("preserves worker failure if RAM recovers while it is pending", async () => {
    vi.useFakeTimers();
    const harness = makeCpuWorkerHarness();
    const worker = workerDeferred<{ stdout: string; stderr: string }>();
    harness.run.mockImplementationOnce(() => worker.promise);
    const failure = new Error("failed before RAM recovered");
    const observed: unknown[] = [];
    const running = harness.collect().catch((error: unknown) => {
      observed.push(error);
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      worker.reject(failure);
      harness.ram.freeRatio = 0.5;
      await vi.advanceTimersByTimeAsync(100);
      await running;
      expect(observed).toEqual([failure]);
      expect(harness.controller.signal.aborted).toBe(false);
    } finally {
      worker.reject(failure);
      harness.controller.abort();
      await running;
    }
  });

  it("allows caller cancellation during a healthy RAM wait", async () => {
    vi.useFakeTimers();
    const harness = makeCpuWorkerHarness();
    const observed: unknown[] = [];
    const running = harness.collect().catch((error: unknown) => {
      observed.push(error);
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.run).toHaveBeenCalledTimes(1);
    harness.controller.abort();
    await running;
    expect(observed).toEqual([expect.objectContaining({ name: "AbortError" })]);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function makeCpuWorkerHarness() {
  const ram = { freeRatio: 0.1 };
  const controller = new AbortController();
  const progress = vi.fn(() => undefined);
  const config = createConfig("win32", () => ram.freeRatio, progress);
  const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
  const cleanup = vi.fn<() => Promise<void>>(async () => undefined);
  const stopPoller = vi.fn();
  const workers = createOcrCpuWorkers({
    ...config,
    path,
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    emitRuntimeProgress: () => undefined,
    readPositiveInteger: (value: unknown) =>
      Number(value) > 0 ? Number(value) : null,
    resolveOcrEngineLabel: () => "HayaiOCR",
    createOcrBatchProgressEmitter: () => () => undefined,
    createProgressLineHandler: () => () => undefined,
    createOcrCommandProgressHandler: () => () => undefined,
    createOcrBatchProgressFilePoller: () => ({
      start: () => undefined,
      stop: stopPoller,
    }),
    buildOcrBboxBatchCommand: () => ({
      executable: "controlled-python",
      args: [],
    }),
    formatCommandForLog: () => "controlled OCR command",
    runOcrCommandWithModelRepair: run,
    resolveOcrBboxTimeoutMs: () => 1000,
    cleanupOcrBatchControlFiles: cleanup,
    readOcrBatchOutputPayload: () => ({ boxes: [] }),
    normalizeOcrBboxHintPayload: () => [],
    buildOcrBboxResult: (hints: unknown[], diagnostics: unknown[]) => ({
      hints,
      diagnostics,
      noTextDetected: true,
      textEvidenceCount: 0,
    }),
    createDetailedError: (message: string) => new Error(message),
    truncateText: (value: unknown, limit: number) =>
      String(value).slice(0, limit),
  });
  const options = {
    ocrDevice: "cpu",
    ocrCpuWorkerStartDelayMs: 1,
    ocrCpuWorkerRamPollMs: 10,
    ocrCpuWorkerMinFreeRamPercent: 20,
    abortSignal: controller.signal,
  };
  const collect = () =>
    workers.collectOcrBboxHintsBatchInCpuWorkers({
      batchOptions: options,
      firstOptions: options,
      normalizedOptions: [options, options],
      items: [
        { image: "one.png", output: "one.json" },
        { image: "two.png", output: "two.json" },
      ],
      provider: "hayai",
      runtime: null,
      workerCount: 2,
    });
  return { collect, controller, ram, run, cleanup, progress, stopPoller };
}

function workerDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("OCR CPU worker configuration", () => {
  it("keeps parallel workers on macOS", () => {
    expect(createConfig("darwin").resolveOcrCpuWorkerCount({}, 3)).toBe(3);
  });

  it("disables the unreliable macOS free-memory floor by default", () => {
    const config = createConfig("darwin");
    expect(config.resolveOcrCpuWorkerMinFreeRamRatio()).toBe(0);
    expect(
      config.resolveOcrCpuWorkerMinFreeRamRatio({
        ocrCpuWorkerMinFreeRamPercent: 35,
      }),
    ).toBe(0.35);
  });

  it("keeps the existing worker and memory defaults on Windows", () => {
    const config = createConfig("win32");
    expect(config.resolveOcrCpuWorkerCount({}, 5)).toBe(4);
    expect(config.resolveOcrCpuWorkerMinFreeRamRatio()).toBe(0.2);
  });

  it("never waits for RAM before the first CPU worker", async () => {
    const config = createConfig("win32");
    await expect(
      config.waitForOcrCpuWorkerRamHeadroom({}, 0),
    ).resolves.toBeUndefined();
    await expect(
      config.waitForOcrCpuWorkerRamHeadroom(
        { ocrCpuWorkerMinFreeRamPercent: 0 },
        1,
      ),
    ).resolves.toBeUndefined();
    expect(
      config.hasOcrCpuWorkerRamHeadroom({ freeRatio: 0 }, Number.NaN),
    ).toBe(true);
  });
});
