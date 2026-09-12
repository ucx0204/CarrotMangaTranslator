import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { queryNvidiaGpuInfo } from "../src/main/gpuInfo";
import type { DetectedGpuInfo } from "../src/main/gpuInfoTypes";
import { resolveFluxCudaDevice } from "../src/main/inpainting/fluxCudaDevice";
import { buildFluxWorkerEnv } from "../src/main/inpainting/fluxWorkerEnv";
import { applyComputeGpuVisibilityEnv } from "../src/main/inpainting/computeGpuEnv";
import type { FluxWorkerLaunchSpec } from "../src/main/inpainting/fluxWorkerTypes";

const UUID = "GPU-22222222-2222-2222-2222-222222222222";
const GPU: DetectedGpuInfo = {
  name: "NVIDIA GeForce RTX 5070 Ti",
  memoryMb: 16303,
  rtxGeneration: 50,
  computeCapability: 12,
  vendor: "nvidia",
  nvidiaUuid: UUID,
};
const LAUNCH: FluxWorkerLaunchSpec = {
  backend: "cuda-native",
  executable: process.execPath,
  runtimePath: process.execPath,
  args: [],
  label: "Flux binding test",
};

describe("Flux physical CUDA device binding", () => {
  it("binds an automatic mixed-generation selection to the GPU owning the SM target", async () => {
    const cudaDevice = await resolveFluxCudaDevice(
      "cuda-native",
      undefined,
      (index) =>
        queryNvidiaGpuInfo(index, async () =>
          [
            "NVIDIA GeForce RTX 3080 Ti, 12288, 8.6, GPU-11111111-1111-1111-1111-111111111111",
            `${GPU.name}, ${GPU.memoryMb}, 12.0, ${UUID}`,
          ].join("\n"),
        ),
    );
    const env = buildFluxWorkerEnv({ ...LAUNCH, cudaDevice });
    expect(cudaDevice?.computeCapability).toBe(12);
    expect(env.CUDA_VISIBLE_DEVICES).toBe(UUID);
  });

  it("does not let a numeric ordinal or launch environment overwrite the resolved UUID", async () => {
    const cudaDevice = await resolveFluxCudaDevice(
      "cuda-native",
      1,
      async () => GPU,
    );
    const env = buildFluxWorkerEnv({
      ...LAUNCH,
      computeGpuIndex: 1,
      cudaDevice,
      env: {
        CUDA_VISIBLE_DEVICES: "0",
        HIP_VISIBLE_DEVICES: "0",
        ROCR_VISIBLE_DEVICES: "0",
        GPU_DEVICE_ORDINAL: "0",
        KEEP_ME: "yes",
      },
    });
    expect(env.CUDA_VISIBLE_DEVICES).toBe(UUID);
    expect(env.HIP_VISIBLE_DEVICES).toBeUndefined();
    expect(env.ROCR_VISIBLE_DEVICES).toBeUndefined();
    expect(env.GPU_DEVICE_ORDINAL).toBeUndefined();
    expect(env.KEEP_ME).toBe("yes");
  });

  it("passes the resolved UUID across a real child-process boundary", async () => {
    const cudaDevice = await resolveFluxCudaDevice(
      "cuda-native",
      1,
      async () => GPU,
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["-e", "process.stdout.write(process.env.CUDA_VISIBLE_DEVICES ?? '')"],
      {
        env: buildFluxWorkerEnv({ ...LAUNCH, computeGpuIndex: 1, cudaDevice }),
        windowsHide: true,
        timeout: 5_000,
      },
    );
    expect(stdout).toBe(UUID);
  });

  it("preserves legacy numeric environment routing when no identity was supplied", () => {
    const env = buildFluxWorkerEnv({ ...LAUNCH, computeGpuIndex: 0 });
    expect(env.CUDA_VISIBLE_DEVICES).toBe("0");
  });

  it("fails before launching when identity or architecture cannot be established", async () => {
    for (const gpu of [
      null,
      { ...GPU, vendor: "amd" as const },
      { ...GPU, nvidiaUuid: undefined },
      { ...GPU, nvidiaUuid: "GPU-prefix" },
      { ...GPU, computeCapability: null },
      { ...GPU, computeCapability: Number.NaN },
      { ...GPU, computeCapability: 0 },
    ]) {
      await expect(
        resolveFluxCudaDevice("cuda-native", 1, async () => gpu),
      ).rejects.toThrow("Flux CUDA GPU를 확정하지 못했습니다");
    }
  });

  it("rejects an invalid explicit index without probing another GPU", async () => {
    let queried = false;
    await expect(
      resolveFluxCudaDevice("cuda-native", -1, async () => {
        queried = true;
        return GPU;
      }),
    ).rejects.toThrow("유효하지 않은 Flux 연산 GPU 번호");
    expect(queried).toBe(false);
  });

  it("leaves all non-CUDA backends independent of NVIDIA detection", async () => {
    for (const backend of [
      "cpu-native",
      "metal-native",
      "zluda-native",
      "python-rocm",
      "python-cpu",
    ]) {
      let queried = false;
      const device = await resolveFluxCudaDevice(backend, 1, async () => {
        queried = true;
        return GPU;
      });
      expect(device).toBeUndefined();
      expect(queried).toBe(false);
    }
  });

  it("binds the experimental SM75 path to its resolved physical device too", async () => {
    const device = await resolveFluxCudaDevice(
      "cuda-sm75-experimental",
      0,
      async () => ({ ...GPU, computeCapability: 7.5 }),
    );
    expect(device?.uuid).toBe(UUID);
    expect(device?.computeCapability).toBe(7.5);
  });

  it("does not apply NVIDIA UUIDs to AMD visibility variables", () => {
    const env: NodeJS.ProcessEnv = { KEEP_ME: "yes" };
    applyComputeGpuVisibilityEnv(env, UUID, "zluda-native", "win32");
    expect(env).toEqual({ KEEP_ME: "yes" });
    applyComputeGpuVisibilityEnv(env, 2, "zluda-native", "win32");
    expect(env).toEqual({ KEEP_ME: "yes", HIP_VISIBLE_DEVICES: "2" });
  });

  it("ignores a stale CUDA descriptor on a non-CUDA launch", () => {
    const env = buildFluxWorkerEnv({
      ...LAUNCH,
      backend: "cpu-native",
      cudaDevice: { uuid: UUID, name: GPU.name, computeCapability: 12 },
    });
    expect(env.CUDA_VISIBLE_DEVICES).toBeUndefined();
  });
});
