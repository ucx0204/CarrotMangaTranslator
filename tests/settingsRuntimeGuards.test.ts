import { describe, expect, it } from "vitest";
import {
  isFluxBackendIncompatible,
  resolveCompatibleFluxBackend,
  resolveCompatibleOcrSettings,
  resolveNvidiaFeatureFlags,
} from "../src/renderer/src/components/settingsModal/useSettingsRuntimeGuards";

const baseRuntime = {
  usesAmdHardware: false,
  usesAppleHardware: false,
  usesNvidiaHardware: true,
  usesRtx50Hardware: false,
  usesSm75Hardware: false,
  supportsFluxZluda: undefined,
  supportsOcrRocm: undefined,
  unifiedMemoryMb: null,
  usesAmdOcrContext: false,
  usesNvidiaOcrContext: true,
};

describe("Flux settings runtime guards", () => {
  it("keeps NVIDIA-only feature flags off on other hardware", () => {
    expect(resolveNvidiaFeatureFlags(false, undefined)).toEqual({
      usesRtx50Hardware: false,
      usesSm75Hardware: false,
    });
  });

  it("enables only SM75 CUDA on detected SM75 NVIDIA hardware", () => {
    const runtime = { ...baseRuntime, usesSm75Hardware: true };

    expect(isFluxBackendIncompatible("cuda-native", runtime)).toBe(true);
    expect(isFluxBackendIncompatible("cuda-sm75-experimental", runtime)).toBe(
      false,
    );
    expect(
      resolveCompatibleFluxBackend(
        "cuda-native",
        "cuda-native",
        false,
        false,
        true,
        true,
      ),
    ).toBe("cuda-sm75-experimental");
  });

  it("enables standard CUDA and disables SM75 CUDA on newer NVIDIA hardware", () => {
    expect(isFluxBackendIncompatible("cuda-native", baseRuntime)).toBe(false);
    expect(
      isFluxBackendIncompatible("cuda-sm75-experimental", baseRuntime),
    ).toBe(true);
    expect(
      resolveCompatibleFluxBackend(
        "cuda-sm75-experimental",
        "cuda-sm75-experimental",
        false,
        false,
        true,
        false,
      ),
    ).toBe("cuda-native");
  });

  it("rejects NVIDIA CUDA backends on AMD while keeping ZLUDA available", () => {
    const runtime = {
      ...baseRuntime,
      usesAmdHardware: true,
      usesNvidiaHardware: false,
    };

    expect(isFluxBackendIncompatible("cuda-native", runtime)).toBe(true);
    expect(isFluxBackendIncompatible("zluda-native", runtime)).toBe(false);
  });
});

describe("OCR settings runtime guards", () => {
  const gpuFull = {
    ocrDevice: "gpu" as const,
    ocrGpuBackend: "cuda" as const,
    ocrQualityMode: "full" as const,
  };

  it("preserves explicit OCR device and backend choices on unsupported AMD", () => {
    expect(
      resolveCompatibleOcrSettings(gpuFull, {
        supportsOcrRocm: false,
        usesAmdOcrContext: true,
        usesNvidiaOcrContext: false,
      }),
    ).toEqual(gpuFull);
    expect(
      resolveCompatibleOcrSettings(
        { ...gpuFull, ocrGpuBackend: "rocm-transformers" },
        {
          supportsOcrRocm: false,
          usesAmdOcrContext: true,
          usesNvidiaOcrContext: false,
        },
      ),
    ).toEqual({ ...gpuFull, ocrGpuBackend: "rocm-transformers" });
  });

  it("does not infer a different AMD backend from detected hardware", () => {
    for (const supportsOcrRocm of [true, undefined]) {
      expect(
        resolveCompatibleOcrSettings(gpuFull, {
          supportsOcrRocm,
          usesAmdOcrContext: true,
          usesNvidiaOcrContext: false,
        }),
      ).toEqual(gpuFull);
    }
  });

  it("preserves NVIDIA, unknown, and CPU quality behavior", () => {
    expect(
      resolveCompatibleOcrSettings(
        { ...gpuFull, ocrGpuBackend: "rocm-transformers" },
        {
          supportsOcrRocm: undefined,
          usesAmdOcrContext: false,
          usesNvidiaOcrContext: true,
        },
      ),
    ).toEqual({ ...gpuFull, ocrGpuBackend: "rocm-transformers" });
    expect(
      resolveCompatibleOcrSettings(gpuFull, {
        supportsOcrRocm: undefined,
        usesAmdOcrContext: false,
        usesNvidiaOcrContext: false,
      }),
    ).toEqual(gpuFull);
    expect(
      resolveCompatibleOcrSettings(
        { ...gpuFull, ocrDevice: "cpu" },
        {
          supportsOcrRocm: undefined,
          usesAmdOcrContext: false,
          usesNvidiaOcrContext: false,
        },
      ),
    ).toEqual({
      ...gpuFull,
      ocrDevice: "cpu",
      ocrQualityMode: "economy",
    });
  });
});
