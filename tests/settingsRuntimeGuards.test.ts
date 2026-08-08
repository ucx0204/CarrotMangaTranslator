import { describe, expect, it } from "vitest";
import {
  isFluxBackendIncompatible,
  resolveCompatibleFluxBackend,
} from "../src/renderer/src/components/settingsModal/useSettingsRuntimeGuards";

const baseRuntime = {
  usesAmdHardware: false,
  usesAppleHardware: false,
  usesNvidiaHardware: true,
  usesSm75Hardware: false,
  unifiedMemoryMb: null,
  usesAmdOcrContext: false,
  usesNvidiaOcrContext: true,
};

describe("Flux settings runtime guards", () => {
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
});
