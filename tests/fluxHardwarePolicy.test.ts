import { describe, expect, it } from "vitest";
import {
  FLUX_NVIDIA_RUNNER_COMPUTE_CAPS,
  resolveDefaultFluxNvidiaBackend,
} from "../src/shared/fluxHardwarePolicy";
import { FLUX_NVIDIA_RUNNER_ASSETS } from "../src/main/inpainting/fluxAssets/constants";
import { resolveHardwareRecommendation } from "../src/renderer/src/components/settingsModal/hardwareRecommendation";
import { resolveDefaultAppSettings } from "../src/main/appSettings";

describe("Flux hardware defaults", () => {
  it("keeps the supported architecture inventory bound to published runner assets", () => {
    expect(FLUX_NVIDIA_RUNNER_COMPUTE_CAPS).toEqual([
      "75",
      "80",
      "86",
      "89",
      "90",
      "120",
    ]);
    expect(Object.keys(FLUX_NVIDIA_RUNNER_ASSETS)).toEqual(
      FLUX_NVIDIA_RUNNER_COMPUTE_CAPS,
    );
  });

  it.each([
    [6.1, null, "cpu-native"],
    [7.0, null, "cpu-native"],
    [7.5, null, "cpu-native"],
    [7.5, 20, "cuda-sm75-experimental"],
    [8.0, null, "cuda-native"],
    [8.6, 30, "cuda-native"],
    [8.7, null, "cpu-native"],
    [8.9, 40, "cuda-native"],
    [9.0, null, "cuda-native"],
    [12.0, 50, "cuda-native"],
    [null, null, "cpu-native"],
    [null, 20, "cpu-native"],
    [null, 30, "cuda-native"],
    [NaN, null, "cpu-native"],
  ])(
    "selects a compatible default for capability %s / RTX %s",
    (computeCapability, rtxGeneration, expected) => {
      const gpu = {
        name: "Detected NVIDIA adapter",
        vendor: "nvidia" as const,
        memoryMb: 8192,
        computeCapability: computeCapability as number | null,
        rtxGeneration: rtxGeneration as number | null,
      };
      const defaults = resolveDefaultAppSettings({}, gpu);
      const recommendation = resolveHardwareRecommendation({
        ...gpu,
        gpuMemoryMb: gpu.memoryMb,
        unifiedMemoryMb: null,
        usesNvidiaHardware: true,
        usesAmdHardware: false,
        usesAppleHardware: false,
      });
      expect(resolveDefaultFluxNvidiaBackend(gpu)).toBe(expected);
      expect(defaults.inpainting?.fluxBackend).toBe(expected);
      expect(recommendation.fluxBackend).toBe(expected);
      const model = expected === "cpu-native" ? "aot-inpainting" : "flux-klein";
      expect(defaults.inpainting?.model).toBe(model);
      expect(recommendation.inpaintingModel).toBe(model);
    },
  );
});
