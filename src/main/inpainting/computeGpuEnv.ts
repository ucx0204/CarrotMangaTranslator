import { normalizeComputeGpuIndex } from "../../shared/gpuSettings";

const GPU_VISIBILITY_ENV_KEYS = [
  "CUDA_VISIBLE_DEVICES",
  "HIP_VISIBLE_DEVICES",
  "ROCR_VISIBLE_DEVICES",
  "GPU_DEVICE_ORDINAL",
] as const;

export function applyComputeGpuVisibilityEnv(
  env: NodeJS.ProcessEnv,
  computeGpuIndex: unknown,
  backend: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const index = normalizeComputeGpuIndex(computeGpuIndex);
  const isolationKey = resolveGpuIsolationKey(backend, platform);
  if (index === undefined || !isolationKey) {
    return;
  }
  for (const key of GPU_VISIBILITY_ENV_KEYS) {
    delete env[key];
  }
  const device = String(index);
  env[isolationKey] = device;
}

function resolveGpuIsolationKey(
  backend: string,
  platform: NodeJS.Platform,
): (typeof GPU_VISIBILITY_ENV_KEYS)[number] | null {
  if (backend === "cuda" || backend === "cuda-native") {
    return "CUDA_VISIBLE_DEVICES";
  }
  if (
    backend === "rocm-transformers" ||
    backend === "python-rocm" ||
    backend === "zluda-native"
  ) {
    return platform === "win32"
      ? "HIP_VISIBLE_DEVICES"
      : "ROCR_VISIBLE_DEVICES";
  }
  return null;
}
