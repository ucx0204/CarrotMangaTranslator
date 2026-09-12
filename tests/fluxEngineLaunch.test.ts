import { describe, expect, it } from "vitest";
import { queryNvidiaGpuInfo } from "../src/main/gpuInfo";
import { prepareFluxWorkerLaunch } from "../src/main/inpainting/fluxEngineLaunch";
import { buildFluxWorkerEnv } from "../src/main/inpainting/fluxWorkerEnv";
import type { FluxWorkerLaunchSpec } from "../src/main/inpainting/fluxWorkerTypes";

const UUID = "GPU-22222222-2222-2222-2222-222222222222";
const DEVICE = { uuid: UUID, name: "RTX 5070 Ti", computeCapability: 12 };
const RUNTIME: FluxWorkerLaunchSpec = {
  backend: "cuda-native",
  executable: process.execPath,
  runtimePath: process.execPath,
  args: [],
  label: "Flux launch test",
};
const OPTIONS = { runtimeDir: "runtime", modelDir: "model" };

describe("Flux engine launch selection", () => {
  it("resolves direct engine callers and ignores a mismatched architecture hint", async () => {
    const capabilities: Array<number | null | undefined> = [];
    const launch = await prepareFluxWorkerLaunch(
      { ...OPTIONS, nvidiaComputeCapability: 8.6 },
      {
        queryGpu: (index) =>
          queryNvidiaGpuInfo(
            index,
            async () => `${DEVICE.name}, 16303, 12.0, ${UUID}`,
          ),
        prepareRuntime: async (options) => {
          capabilities.push(options.nvidiaComputeCapability);
          return RUNTIME;
        },
      },
    );
    expect(capabilities).toEqual([12]);
    expect(launch.cudaDevice).toEqual(DEVICE);
    expect(buildFluxWorkerEnv(launch).CUDA_VISIBLE_DEVICES).toBe(UUID);
  });

  it("uses the pool's existing snapshot instead of independently probing again", async () => {
    let queried = false;
    const launch = await prepareFluxWorkerLaunch(
      { ...OPTIONS, computeGpuIndex: 1, cudaDevice: DEVICE },
      {
        queryGpu: async () => {
          queried = true;
          return null;
        },
        prepareRuntime: async () => RUNTIME,
      },
    );
    expect(queried).toBe(false);
    expect(launch.cudaDevice).toBe(DEVICE);
    expect(launch.computeGpuIndex).toBe(1);
    expect(buildFluxWorkerEnv(launch).CUDA_VISIBLE_DEVICES).toBe(UUID);
  });

  it("does not prepare a runtime after the NVIDIA probe fails", async () => {
    let prepared = false;
    await expect(
      prepareFluxWorkerLaunch(OPTIONS, {
        queryGpu: async () => null,
        prepareRuntime: async () => {
          prepared = true;
          return RUNTIME;
        },
      }),
    ).rejects.toThrow("Flux CUDA GPU를 확정하지 못했습니다");
    expect(prepared).toBe(false);
  });

  it("does not invoke NVIDIA detection for a CPU launch", async () => {
    let queried = false;
    const launch = await prepareFluxWorkerLaunch(
      { ...OPTIONS, fluxBackend: "cpu-native", cudaDevice: DEVICE },
      {
        queryGpu: async () => {
          queried = true;
          return null;
        },
        prepareRuntime: async () => ({ ...RUNTIME, backend: "cpu-native" }),
      },
    );
    expect(queried).toBe(false);
    expect(launch.cudaDevice).toBeUndefined();
  });

  it("does not prepare the runtime when cancellation arrives during detection", async () => {
    const controller = new AbortController();
    let prepared = false;
    await expect(
      prepareFluxWorkerLaunch(
        { ...OPTIONS, signal: controller.signal },
        {
          queryGpu: async () => {
            controller.abort(new Error("cancelled during GPU detection"));
            return null;
          },
          prepareRuntime: async () => {
            prepared = true;
            return RUNTIME;
          },
        },
      ),
    ).rejects.toThrow("cancelled during GPU detection");
    expect(prepared).toBe(false);
  });
});
