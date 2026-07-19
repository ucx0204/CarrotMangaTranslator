import { describe, expect, it } from "vitest";

const { createOcrBatchConfig } =
  require("../src/main/runtime/ocr/bbox-batch-config.cjs") as {
    createOcrBatchConfig: (dependencies: {
      os: {
        cpus: () => unknown[];
        platform: () => NodeJS.Platform;
      };
      runtimeOverrideEnv: () => undefined;
      readPositiveInteger: (value: unknown) => number | null;
      emitRuntimeProgress: () => void;
    }) => {
      resolveOcrCpuWorkerCount: (
        options: { ocrCpuWorkers?: number },
        pageCount: number,
      ) => number;
      resolveOcrCpuWorkerMinFreeRamRatio: (options?: {
        ocrCpuWorkerMinFreeRamPercent?: number;
      }) => number;
    };
  };

function createConfig(platform: NodeJS.Platform) {
  return createOcrBatchConfig({
    os: {
      cpus: () => Array.from({ length: 8 }, () => ({})),
      platform: () => platform,
    },
    runtimeOverrideEnv: () => undefined,
    readPositiveInteger: (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    },
    emitRuntimeProgress: () => undefined,
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
});
