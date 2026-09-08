import type { FluxBackend } from "./inpaintingSettingsTypes";
import { isFluxRtx20Sm75Hardware } from "./fluxSm75";

// Keep automatic selection aligned with the CUDA runners the app distributes.
export const FLUX_NVIDIA_RUNNER_COMPUTE_CAPS = [
  "75",
  "80",
  "86",
  "89",
  "90",
  "120",
];

export function resolveDefaultFluxNvidiaBackend(options: {
  computeCapability?: number | null;
  rtxGeneration?: number | null;
}): FluxBackend {
  if (
    isFluxRtx20Sm75Hardware({
      computeCapability: options.computeCapability,
      rtxGeneration: options.rtxGeneration,
    })
  )
    return "cuda-sm75-experimental";

  const capability = options.computeCapability;
  if (capability != null) {
    const architecture = String(Math.round(capability * 10));
    return architecture !== "75" &&
      FLUX_NVIDIA_RUNNER_COMPUTE_CAPS.includes(architecture)
      ? "cuda-native"
      : "cpu-native";
  }
  // Older nvidia-smi versions may report the model without compute_cap.
  return [30, 40, 50].includes(options.rtxGeneration ?? 0)
    ? "cuda-native"
    : "cpu-native";
}
