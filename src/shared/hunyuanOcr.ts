import type {
  AppSettings,
  OcrPipeline,
  HunyuanSettings,
} from "./settingsTypes";
import { isJapaneseLanguageCode } from "./translationLanguages";

export type HunyuanExecution = {
  model: "f16" | "q4";
  device: "gpu" | "cpu";
  backend: "cuda" | "vulkan" | "metal" | "cpu";
};
export const HUNYUAN_DEFAULTS: HunyuanSettings = {
  model: "f16",
  device: "auto",
};

export function normalizeHunyuanSettings(value: unknown): HunyuanSettings {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    model:
      record.model === "auto" || record.model === "q4" ? record.model : "f16",
    device:
      record.device === "cpu" || record.device === "gpu"
        ? record.device
        : "auto",
  };
}

export function recommendedOcrPipeline(
  sourceLanguage: string | undefined,
): OcrPipeline | null {
  if (sourceLanguage === undefined || sourceLanguage === "auto") return null;
  return isJapaneseLanguageCode(sourceLanguage) ? "hayai" : "hunyuan";
}

/** Recommendations are memory budgets, never hard limits on manual choices. */
export function resolveHunyuanExecution(
  selection: HunyuanSettings,
  hardware: AppSettings["runtimeHardware"],
  _systemMemoryMb: number,
  platform: string,
): HunyuanExecution {
  const backend = availableBackend(hardware, platform);
  const apple = backend === "metal";
  const memory = apple ? hardware?.unifiedMemoryMb : hardware?.gpuMemoryMb;
  const knownMemory = typeof memory === "number" && Number.isFinite(memory);
  const recommendedGpu =
    backend !== "cpu" && knownMemory && memory >= (apple ? 8192 : 4096);
  const device =
    selection.device === "auto"
      ? recommendedGpu
        ? "gpu"
        : "cpu"
      : selection.device;
  // Explicit GPU requests remain explicit; the launcher reports unavailable
  // acceleration and performs the same-model CPU retry.
  return {
    // F16 is the user's default even on 4 GiB. Q4 is an explicit economy option.
    model: selection.model === "auto" ? "f16" : selection.model,
    device,
    backend: device === "cpu" ? "cpu" : backend,
  };
}

function availableBackend(
  hardware: AppSettings["runtimeHardware"],
  platform: string,
): HunyuanExecution["backend"] {
  if (platform === "darwin" && hardware?.supportsMetal) return "metal";
  if (platform !== "win32" || !hardware) return "cpu";
  if (hardware.gpuVendor === "nvidia") return "cuda";
  if (hardware.supportsVulkan && ["amd", "intel"].includes(hardware.gpuVendor))
    return "vulkan";
  return "cpu";
}
