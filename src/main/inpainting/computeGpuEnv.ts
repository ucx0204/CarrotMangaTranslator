import {
  normalizeComputeGpuIndex,
  normalizeNvidiaGpuUuid,
} from "../../shared/gpuSettings";

const GPU_VISIBILITY_ENV_KEYS = [
  "CUDA_VISIBLE_DEVICES",
  "HIP_VISIBLE_DEVICES",
  "ROCR_VISIBLE_DEVICES",
  "GPU_DEVICE_ORDINAL",
  "GGML_VK_VISIBLE_DEVICES",
] as const;

export function applyComputeGpuVisibilityEnv(
  env: NodeJS.ProcessEnv,
  computeGpuSelection: unknown,
  backend: string,
  platform: NodeJS.Platform = process.platform,
): void {
  // Native ROCm probes physical adapter 0 when the selection is automatic.
  const index =
    normalizeComputeGpuIndex(computeGpuSelection) ??
    (backend === "rocm-native" || backend === "vulkan-native" ? 0 : undefined);
  const isolationKey = resolveGpuIsolationKey(backend, platform);
  const uuid =
    isolationKey === "CUDA_VISIBLE_DEVICES"
      ? normalizeNvidiaGpuUuid(computeGpuSelection)
      : undefined;
  const device = uuid ?? (index === undefined ? undefined : String(index));
  if (device === undefined || !isolationKey) {
    return;
  }
  for (const key of GPU_VISIBILITY_ENV_KEYS) {
    delete env[key];
  }
  env[isolationKey] = device;
}

function resolveGpuIsolationKey(
  backend: string,
  platform: NodeJS.Platform,
): (typeof GPU_VISIBILITY_ENV_KEYS)[number] | null {
  if (backend === "vulkan-native") return "GGML_VK_VISIBLE_DEVICES";
  if (backend === "cuda" || backend === "cuda-native") {
    return "CUDA_VISIBLE_DEVICES";
  }
  if (
    backend === "rocm-transformers" ||
    backend === "python-rocm" ||
    backend === "rocm-native" ||
    backend === "zluda-native"
  ) {
    return platform === "win32"
      ? "HIP_VISIBLE_DEVICES"
      : "ROCR_VISIBLE_DEVICES";
  }
  return null;
}
