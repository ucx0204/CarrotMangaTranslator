import { describe, expect, it } from "vitest";
import { resolveWindowsHipSdkGpuSupport } from "../src/main/settings/fluxZludaSupport";

describe("Windows HIP SDK GPU support classification", () => {
  it.each([
    ["AMD Radeon RX 7900 XTX", undefined],
    ["AMD Radeon RX 7600", undefined],
    ["AMD Radeon RX 9070 XT", undefined],
    ["AMD Radeon PRO W7700", undefined],
    ["AMD Ryzen AI Max+ 395", undefined],
    ["Unknown AMD adapter", "gfx1102"],
    ["Unknown AMD adapter", "gfx1150"],
  ])("marks %s (%s) as officially supported", (name, rocmArch) => {
    expect(
      resolveWindowsHipSdkGpuSupport({
        name,
        memoryMb: 12_288,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        rocmArch,
      }),
    ).toBe(true);
  });

  it.each([
    ["AMD Radeon RX 6700 XT", undefined],
    ["AMD Radeon RX 6800", "gfx1030"],
    ["AMD Radeon RX 7600M XT", undefined],
    ["AMD Radeon PRO W6800", undefined],
    ["AMD Radeon 780M", "gfx1103"],
    ["AMD Radeon RX 7700S", undefined],
  ])("marks %s (%s) as officially unsupported", (name, rocmArch) => {
    expect(
      resolveWindowsHipSdkGpuSupport({
        name,
        memoryMb: 12_288,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        rocmArch,
      }),
    ).toBe(false);
  });

  it("leaves unidentifiable adapters unknown instead of showing a false warning", () => {
    expect(
      resolveWindowsHipSdkGpuSupport({
        name: "AMD Radeon Graphics",
        memoryMb: null,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
      }),
    ).toBeUndefined();
    expect(
      resolveWindowsHipSdkGpuSupport({
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24_576,
        rtxGeneration: 40,
        computeCapability: 8.9,
        vendor: "nvidia",
      }),
    ).toBeUndefined();
  });
});
