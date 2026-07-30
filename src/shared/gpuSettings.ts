export const MIN_COMPUTE_GPU_INDEX = 0;
export const MAX_COMPUTE_GPU_INDEX = 15;

export type GraphicsGpuPreference = "auto" | "high-performance";

export type HardwareGpuSettings = {
  /**
   * Chromium/Electron graphics preference. This affects window compositing and
   * takes full effect after the app restarts.
   */
  graphicsGpuPreference?: GraphicsGpuPreference;
  /**
   * Backend-local CUDA/HIP/Vulkan ordinal for local AI workers.
   * Missing means that each runtime keeps its existing automatic policy.
   */
  computeGpuIndex?: number;
};

export function normalizeGraphicsGpuPreference(
  value: unknown,
  fallback: GraphicsGpuPreference = "auto",
): GraphicsGpuPreference {
  return value === "high-performance" || value === "auto" ? value : fallback;
}

export function normalizeComputeGpuIndex(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) &&
    parsed >= MIN_COMPUTE_GPU_INDEX &&
    parsed <= MAX_COMPUTE_GPU_INDEX
    ? parsed
    : undefined;
}
