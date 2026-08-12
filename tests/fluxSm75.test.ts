import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isFluxRtx20Sm75Hardware,
  isFluxSm75ComputeCapability,
  shouldEnableExperimentalSm75Flux,
} from "../src/shared/fluxSm75";
import { FluxBackendSchema } from "../src/shared/ipcEnumSchemas";

describe("experimental Flux SM75 routing", () => {
  it("builds the SM75 runner with an FP32 transformer and FP16 VAE", () => {
    const source = readFileSync(
      resolve("scripts/prepare-flux-klein-runner.cjs"),
      "utf8",
    );
    const patch = /const sm75DtypePatch = `([\s\S]*?)`;/u.exec(source)?.[1];
    const transformer =
      /fn transformer_dtype[\s\S]*?(?=\n\nfn vae_dtype)/u.exec(
        patch ?? "",
      )?.[0];
    const vae = /fn vae_dtype[\s\S]*$/u.exec(patch ?? "")?.[0];

    expect(transformer).toContain("if sm75_fp16_enabled()");
    expect(transformer).toContain("DType::F32");
    expect(transformer).not.toContain("DType::F16");
    expect(vae).toContain("if sm75_fp16_enabled()");
    expect(vae).toContain("DType::F16");
  });

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
