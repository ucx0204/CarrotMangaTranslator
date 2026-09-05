import { describe, expect, it } from "vitest";
import { selectDirectMlAdapter } from "../src/main/runtimeSupport/directMlAdapterPolicy";

const adapters = [
  {
    deviceId: 0,
    name: "Radeon iGPU",
    luid: "igpu",
    highPerformanceRank: 2,
    dedicatedVideoMemory: 512,
  },
  {
    deviceId: 2,
    name: "RTX 3060",
    luid: "nvidia",
    highPerformanceRank: 1,
    dedicatedVideoMemory: 6144,
  },
  {
    deviceId: 4,
    name: "External GPU",
    luid: "egpu",
    highPerformanceRank: 0,
    dedicatedVideoMemory: 16384,
  },
];

describe("DirectML adapter policy", () => {
  it("preserves DXGI ordinals across filtering and performance sorting", () => {
    expect(selectDirectMlAdapter({}, adapters).deviceId).toBe(0);
    expect(
      selectDirectMlAdapter(
        { graphicsGpuPreference: "high-performance" },
        adapters,
      ).deviceId,
    ).toBe(4);
    expect(adapters.map((adapter) => adapter.deviceId)).toEqual([0, 2, 4]);
  });
  it("uses the CUDA LUID even with same-name GPUs and a different DXGI order", () => {
    const sameName = adapters.map((adapter) => ({
      ...adapter,
      name: "Same name",
    }));
    expect(
      selectDirectMlAdapter(
        { computeGpuBackend: "cuda", computeGpuIndex: 0 },
        sameName,
        "nvidia",
      ).deviceId,
    ).toBe(2);
  });
  it("rejects missing or ambiguous CUDA identities instead of guessing by ordinal", () => {
    const request = { computeGpuBackend: "cuda", computeGpuIndex: 2 };
    expect(() => selectDirectMlAdapter(request, adapters)).toThrow("LUID");
    expect(() => selectDirectMlAdapter(request, adapters, "absent")).toThrow(
      "LUID",
    );
    expect(() =>
      selectDirectMlAdapter(request, [...adapters, adapters[1]], "nvidia"),
    ).toThrow("LUID");
  });
  it("never reuses HIP or Vulkan ordinals as DXGI ordinals", () => {
    expect(
      selectDirectMlAdapter(
        {
          computeGpuBackend: "rocm",
          computeGpuIndex: 2,
          graphicsGpuPreference: "high-performance",
        },
        adapters,
      ).deviceId,
    ).toBe(4);
  });
  it("rejects an empty hardware adapter list", () => {
    expect(() => selectDirectMlAdapter({}, [])).toThrow("Windows GPU");
  });
});
