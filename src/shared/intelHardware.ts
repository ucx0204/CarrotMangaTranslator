import type {
  FluxBackend,
  FluxMode,
  InpaintingModel,
} from "./inpaintingSettingsTypes";

import type {
  LlamaRuntimeProfile,
  OcrPipeline,
  OcrGpuBackend,
} from "./settingsTypes";

export type IntelGpuSupport = { vulkan: boolean; hayaiXpu: boolean };

export function resolveIntelModelSettings(
  supportsVulkan: boolean,
  memoryMb?: number | null,
): {
  fluxBackend: FluxBackend;
  fluxMode: FluxMode;
  inpaintingModel: InpaintingModel;
} {
  // Integrated Vulkan devices share system RAM. Keep the large image models
  // available manually without automatically scheduling one on shared memory.
  return {
    fluxBackend: supportsVulkan ? "vulkan-native" : "cpu-native",
    fluxMode: (memoryMb ?? 0) <= 8192 ? "light" : "normal",
    inpaintingModel:
      supportsVulkan && (memoryMb ?? 0) >= 16384
        ? "qwen-image-2.1"
        : "aot-inpainting",
  };
}

// Intel Arc includes discrete A/B-series and the Arc graphics in Core Ultra.
// Iris Xe and UHD can expose Vulkan without supporting PyTorch XPU.
export function supportsIntelHayaiXpu(
  name: string | null | undefined,
): boolean {
  return /\bArc\b/i.test(name ?? "");
}

export function resolveIntelLlamaRuntime(
  profile: LlamaRuntimeProfile,
  vulkan: boolean | undefined,
): LlamaRuntimeProfile {
  return vulkan && profile !== "cpu" ? "vulkan" : "cpu";
}

export function resolveIntelFluxBackend(
  backend: FluxBackend,
  vulkan: boolean | undefined,
): FluxBackend {
  return vulkan && backend !== "cpu-native" ? "vulkan-native" : "cpu-native";
}

export function canUseIntelOcrGpu(
  pipeline: OcrPipeline,
  backend: OcrGpuBackend,
  supportsXpu: boolean,
): boolean {
  return supportsXpu && pipeline === "hayai" && backend === "xpu";
}
