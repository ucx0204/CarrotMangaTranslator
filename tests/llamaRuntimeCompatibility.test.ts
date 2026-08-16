import { describe, expect, it } from "vitest";
import {
  isRtx50Hardware,
  resolveLlamaRuntimeCompatibilityWarning,
} from "../src/renderer/src/components/settingsModal/llamaRuntimeCompatibility";

describe("RTX 50 hardware detection", () => {
  it("prefers compute capability and falls back to the parsed generation", () => {
    expect(isRtx50Hardware(12, 40)).toBe(true);
    expect(isRtx50Hardware(8.9, 50)).toBe(false);
    expect(isRtx50Hardware(null, 50)).toBe(true);
    expect(isRtx50Hardware(null, 40)).toBe(false);
    expect(isRtx50Hardware(null, null)).toBe(false);
  });
});

describe("llama.cpp runtime compatibility warnings", () => {
  it("warns when RTX 50 hardware uses CUDA 12", () => {
    expect(
      resolveLlamaRuntimeCompatibilityWarning({
        llamaRuntimeProfile: "cuda12",
        usesNvidiaHardware: true,
        usesRtx50Hardware: true,
      }),
    ).toBe("rtx50-using-cuda12");
  });

  it("warns when non-RTX 50 hardware uses the RTX 50 runtime", () => {
    expect(
      resolveLlamaRuntimeCompatibilityWarning({
        llamaRuntimeProfile: "rtx50",
        usesNvidiaHardware: true,
        usesRtx50Hardware: false,
      }),
    ).toBe("non-rtx50-using-rtx50");
  });

  it("does not warn for matching NVIDIA or non-NVIDIA runtimes", () => {
    expect(
      resolveLlamaRuntimeCompatibilityWarning({
        llamaRuntimeProfile: "rtx50",
        usesNvidiaHardware: true,
        usesRtx50Hardware: true,
      }),
    ).toBeNull();
    expect(
      resolveLlamaRuntimeCompatibilityWarning({
        llamaRuntimeProfile: "cuda12",
        usesNvidiaHardware: true,
        usesRtx50Hardware: false,
      }),
    ).toBeNull();
    expect(
      resolveLlamaRuntimeCompatibilityWarning({
        llamaRuntimeProfile: "rtx50",
        usesNvidiaHardware: false,
        usesRtx50Hardware: false,
      }),
    ).toBeNull();
  });
});
