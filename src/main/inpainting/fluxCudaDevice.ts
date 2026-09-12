import { queryNvidiaGpuInfo } from "../gpuInfo";
import type { DetectedGpuInfo } from "../gpuInfoTypes";
import {
  normalizeComputeGpuIndex,
  normalizeNvidiaGpuUuid,
} from "../../shared/gpuSettings";
import type { FluxCudaDevice } from "./fluxWorkerTypes";

/** Resolve identity and architecture together, before selecting an SM runner. */
export async function resolveFluxCudaDevice(
  backend: string,
  computeGpuIndex?: number,
  queryGpu: (
    index?: number,
  ) => Promise<DetectedGpuInfo | null> = queryNvidiaGpuInfo,
  signal?: AbortSignal,
): Promise<FluxCudaDevice | undefined> {
  if (backend !== "cuda-native" && backend !== "cuda-sm75-experimental") {
    return undefined;
  }
  if (
    computeGpuIndex !== undefined &&
    normalizeComputeGpuIndex(computeGpuIndex) === undefined
  ) {
    throw new Error(
      `유효하지 않은 Flux 연산 GPU 번호입니다: ${computeGpuIndex}`,
    );
  }
  signal?.throwIfAborted();
  const gpu = await queryGpu(computeGpuIndex);
  signal?.throwIfAborted();
  return requireFluxCudaDevice(gpu, computeGpuIndex);
}

function requireFluxCudaDevice(
  gpu: DetectedGpuInfo | null,
  computeGpuIndex?: number,
): FluxCudaDevice {
  const uuid = normalizeNvidiaGpuUuid(gpu?.nvidiaUuid);
  const computeCapability = gpu?.computeCapability;
  if (
    gpu?.vendor !== "nvidia" ||
    !uuid ||
    typeof computeCapability !== "number" ||
    !Number.isFinite(computeCapability) ||
    computeCapability <= 0
  ) {
    const selection = computeGpuIndex ?? "auto";
    throw new Error(
      `Flux CUDA GPU를 확정하지 못했습니다 (선택: ${selection}). ` +
        "nvidia-smi에서 GPU UUID와 compute capability를 확인하거나 Flux 백엔드를 CPU로 변경하세요. " +
        "다른 GPU 또는 generic 러너로 자동 대체하지 않습니다.",
    );
  }
  return { uuid, name: gpu.name, computeCapability };
}
