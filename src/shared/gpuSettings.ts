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

/** Full physical-device UUIDs only; never accept an ambiguous CUDA prefix/list. */
export function normalizeNvidiaGpuUuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const uuid = value.trim();
  return /^GPU-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(uuid)
    ? `GPU-${uuid.slice(4).toLowerCase()}`
    : undefined;
}
