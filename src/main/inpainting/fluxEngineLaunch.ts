import type { FluxBackend } from "../../shared/inpaintingSettingsTypes";
import { normalizeComputeGpuIndex } from "../../shared/gpuSettings";
import type { queryNvidiaGpuInfo } from "../gpuInfo";
import { ensureFluxWorkerLaunch } from "./fluxAssets/workerLaunch";
import { resolveFluxCudaDevice } from "./fluxCudaDevice";
import type { InpaintingRuntimeProgress } from "./inpaintingEngine";
import type { FluxCudaDevice, FluxWorkerLaunchSpec } from "./fluxWorkerTypes";

export type FluxEngineLaunchOptions = {
  runtimeDir: string;
  modelDir: string;
  fluxBackend?: FluxBackend;
  computeGpuIndex?: number;
  cudaDevice?: FluxCudaDevice;
  /** Legacy hint; resolved device identity owns the capability for CUDA. */
  nvidiaComputeCapability?: number | null;
  sm75Fp16Enabled?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
};

export async function prepareFluxWorkerLaunch(
  options: FluxEngineLaunchOptions,
  ports: {
    queryGpu?: typeof queryNvidiaGpuInfo;
    prepareRuntime?: typeof ensureFluxWorkerLaunch;
  } = {},
): Promise<FluxWorkerLaunchSpec> {
  options.signal?.throwIfAborted();
  const backend = options.fluxBackend ?? "cuda-native";
  const cudaBackend =
    backend === "cuda-native" || backend === "cuda-sm75-experimental";
  const cudaDevice = cudaBackend
    ? (options.cudaDevice ??
      (await resolveFluxCudaDevice(
        backend,
        options.computeGpuIndex,
        ports.queryGpu,
        options.signal,
      )))
    : undefined;
  options.signal?.throwIfAborted();
  const launch = await (ports.prepareRuntime ?? ensureFluxWorkerLaunch)({
    runtimeDir: options.runtimeDir,
    modelDir: options.modelDir,
    backend,
    nvidiaComputeCapability:
      cudaDevice?.computeCapability ?? options.nvidiaComputeCapability,
    sm75Fp16Enabled: options.sm75Fp16Enabled,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  return {
    ...launch,
    computeGpuIndex: normalizeComputeGpuIndex(options.computeGpuIndex),
    cudaDevice,
  };
}
