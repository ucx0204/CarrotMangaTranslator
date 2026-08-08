import { describe, expect, it } from "vitest";
import {
  isFluxRtx20Sm75Hardware,
  isFluxSm75ComputeCapability,
  shouldEnableExperimentalSm75Flux,
} from "../src/shared/fluxSm75";
import { FluxBackendSchema } from "../src/shared/ipcEnumSchemas";

describe("experimental Flux SM75 routing", () => {
  it("recognizes compute capability 7.5 and only enables the explicit backend", () => {
    expect(isFluxSm75ComputeCapability(7.5)).toBe(true);
    expect(isFluxSm75ComputeCapability(8.6)).toBe(false);
    expect(
      isFluxRtx20Sm75Hardware({
        computeCapability: 7.5,
        rtxGeneration: 20,
      }),
    ).toBe(true);
    expect(
      isFluxRtx20Sm75Hardware({
        computeCapability: 7.5,
        rtxGeneration: null,
      }),
    ).toBe(false);
    expect(
      shouldEnableExperimentalSm75Flux({
        backend: "cuda-sm75-experimental",
        computeCapability: 7.5,
      }),
    ).toBe(true);
    expect(
      shouldEnableExperimentalSm75Flux({
        backend: "cuda-sm75-experimental",
        computeCapability: 8.9,
      }),
    ).toBe(false);
    expect(
      shouldEnableExperimentalSm75Flux({
        backend: "cuda-native",
        computeCapability: 7.5,
      }),
    ).toBe(false);
  });

  it("normalizes temporary SM75 backend aliases", () => {
    expect(FluxBackendSchema.parse("sm75")).toBe("cuda-sm75-experimental");
    expect(FluxBackendSchema.parse("cuda-sm75")).toBe("cuda-sm75-experimental");
  });
});
