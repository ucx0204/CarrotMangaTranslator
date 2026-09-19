import { describe, expect, it, vi } from "vitest";
import { resolveKoharuBackendCandidates } from "../src/main/inpainting/koharuEnginePool";
import { buildKoharuWorkerEnv } from "../src/main/inpainting/koharuWorker";
import type { DetectedGpuInfo } from "../src/main/gpuInfoTypes";
import type { KoharuInpaintingBackend } from "../src/shared/inpaintingSettingsTypes";

const devices: Array<
  [
    string,
    DetectedGpuInfo["vendor"],
    number | null,
    string | null,
    KoharuInpaintingBackend,
  ]
> = [
  ["RTX 2080 Ti", "nvidia", 7.5, null, "cuda-native"],
  ["RTX 3080 Ti", "nvidia", 8.6, null, "cuda-native"],
  ["RTX 4060 Ti", "nvidia", 8.9, null, "cuda-native"],
  ["RTX 5090", "nvidia", 12.0, null, "cuda-native"],
  ["Radeon RX 6700 XT", "amd", null, "gfx1031", "zluda-native"],
  ["Radeon RX 7900 XTX", "amd", null, "gfx1100", "zluda-native"],
  ["Radeon RX 9070 XT", "amd", null, "gfx1201", "zluda-native"],
  ["Intel Arc A770", "unknown", null, null, "cpu"],
  ["Intel Arc B580", "unknown", null, null, "cpu"],
  ["Intel integrated graphics", "unknown", null, null, "cpu"],
];

describe("Koharu backend contracts across GPU vendors and generations", () => {
  // These are code-level routing tests, not hardware inference claims.
  it.each(devices)(
    "routes %s without model-name-specific workarounds",
    async (name, vendor, computeCapability, rocmArch, backend) => {
      const detectGpu = vi.fn(
        async (): Promise<DetectedGpuInfo> => ({
          name,
          vendor,
          computeCapability,
          rocmArch,
          memoryMb: 8192,
          rtxGeneration: null,
        }),
      );
      expect(
        await resolveKoharuBackendCandidates("auto", detectGpu, "win32"),
      ).toEqual(backend === "cpu" ? ["cpu"] : [backend, "cpu"]);
      expect(detectGpu).toHaveBeenCalledOnce();
    },
  );

  it("does not attempt NVIDIA or AMD runtimes without a detected GPU", async () => {
    expect(
      await resolveKoharuBackendCandidates("auto", async () => null, "win32"),
    ).toEqual(["cpu"]);
  });

  it("keeps Apple Metal separate from CUDA/ZLUDA", async () => {
    const detectGpu = vi.fn(async () => null);
    expect(
      await resolveKoharuBackendCandidates("auto", detectGpu, "darwin"),
    ).toEqual(["metal-native", "cpu"]);
    expect(detectGpu).not.toHaveBeenCalled();
  });

  it.each(["cpu", "cuda-native", "zluda-native", "metal-native"] as const)(
    "honors explicit %s without probing an unrelated GPU",
    async (backend) => {
      const detectGpu = vi.fn(async () => null);
      expect(
        await resolveKoharuBackendCandidates(backend, detectGpu, "win32"),
      ).toEqual(backend === "cpu" ? ["cpu"] : [backend, "cpu"]);
      expect(detectGpu).not.toHaveBeenCalled();
    },
  );

  it.each(["cuda-native", "zluda-native", "cpu", "metal-native"] as const)(
    "isolates the selected device for %s only in its own API",
    (backend) => {
      const env = buildKoharuWorkerEnv({
        backend,
        executable: process.execPath,
        runtimePath: process.execPath,
        label: "matrix",
        args: [],
        computeGpuIndex: 2,
      });
      if (backend === "cuda-native") {
        expect(env.CUDA_VISIBLE_DEVICES).toBe("2");
        expect(env.HIP_VISIBLE_DEVICES).toBeUndefined();
      } else if (backend === "zluda-native") {
        expect(env.CUDA_VISIBLE_DEVICES).toBeUndefined();
        expect(
          env[
            process.platform === "win32"
              ? "HIP_VISIBLE_DEVICES"
              : "ROCR_VISIBLE_DEVICES"
          ],
        ).toBe("2");
      } else {
        expect(env.CUDA_VISIBLE_DEVICES).toBeUndefined();
        expect(env.HIP_VISIBLE_DEVICES).toBeUndefined();
        expect(env.ROCR_VISIBLE_DEVICES).toBeUndefined();
      }
    },
  );
});
