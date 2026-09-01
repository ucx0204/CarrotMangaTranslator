import { describe, expect, it } from "vitest";

const { createOcrBatchConfig } =
  require("../src/main/runtime/ocr/bbox-batch-config.cjs") as {
    createOcrBatchConfig: (dependencies: {
      os: {
        cpus: () => unknown[];
        platform: () => NodeJS.Platform;
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
    };
  };

function createConfig(platform: NodeJS.Platform) {
  return createOcrBatchConfig({
    os: {
      cpus: () => Array.from({ length: 8 }, () => ({})),
      platform: () => platform,
    },
    runtimeOverrideEnv: () => undefined,
    isHayaiOcrPipeline: (options) => options?.ocrPipeline === "hayai",
    readPositiveInteger: (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    },
    emitRuntimeProgress: () => undefined,
    resolveOcrEngineLabel: () => "HayaiOCR",
  });
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
