import {
  DEFAULT_GEMMA_MMPROJ_FILE,
  DEFAULT_GEMMA_MMPROJ_REPO,
  DEFAULT_OCR_GPU_CUDA_TAG,
  RTX_50_OCR_GPU_CUDA_TAG,
} from "../../shared/modelPresets";
import type {
  AmdRocmTarget,
  AppSettings,
  BubbleDetectionMode,
  FluxBackend,
  GemmaVramMode,
  InpaintingModel,
  KoharuInpaintingBackend,
  LlamaRuntimeProfile,
} from "../../shared/settingsTypes";
import { normalizeAmdRocmTarget } from "../gpuInfo";
import {
  inferHardwareVendorFromDefaults,
  resolveBubbleDetectionMode,
  resolveFluxBackend,
  resolveInpaintingModel,
  resolveKoharuInpaintingBackend,
  resolveNonEmptyString,
  resolveOcrGpuCudaTag,
  resolveOptionalString,
} from "./appSettingsResolvers";
import {
  getDefaultGemmaPresetForVramMode,
  getDefaultMmprojForGemmaModel,
  isBuiltInGemmaMmproj,
  isBuiltInGemmaModel,
} from "./gemmaModelPresets";
import {
  isAmdLlamaRuntimeProfile,
  isMetalLlamaRuntimeProfile,
  isNvidiaLlamaRuntimeProfile,
  isRocmLlamaRuntimeProfile,
  resolveLlamaRuntimeProfile,
} from "./llamaRuntimeProfile";

type GemmaModelSettings = Pick<AppSettings["gemma"], "modelRepo" | "modelFile">;

type GemmaMmprojSettings = Pick<
  AppSettings["gemma"],
  "mmprojRepo" | "mmprojFile"
>;

export function resolveStoredLlamaRuntimeProfile(
  gemma: Record<string, unknown> | null,
  defaults: AppSettings,
): LlamaRuntimeProfile {
  const requested = resolveLlamaRuntimeProfile(
    {},
    gemma?.llamaRuntimeProfile ?? defaults.gemma.llamaRuntimeProfile,
  );
  const hardwareVendor = inferHardwareVendorFromDefaults(defaults);
  if (hardwareVendor === "amd" && isNvidiaLlamaRuntimeProfile(requested)) {
    return resolveLlamaRuntimeProfile({}, defaults.gemma.llamaRuntimeProfile);
  }
  if (hardwareVendor === "nvidia" && isAmdLlamaRuntimeProfile(requested)) {
    return resolveLlamaRuntimeProfile({}, defaults.gemma.llamaRuntimeProfile);
  }
  if (hardwareVendor === "apple" && !isMetalLlamaRuntimeProfile(requested)) {
    return "metal";
  }
  if (hardwareVendor !== "apple" && isMetalLlamaRuntimeProfile(requested)) {
    return resolveLlamaRuntimeProfile({}, defaults.gemma.llamaRuntimeProfile);
  }
  return requested;
}

export function resolveStoredLlamaRocmTarget(
  gemma: Record<string, unknown> | null,
  defaults: AppSettings,
  llamaRuntimeProfile: LlamaRuntimeProfile,
): AmdRocmTarget | undefined {
  const target =
    normalizeAmdRocmTarget(gemma?.llamaRocmTarget) ??
    normalizeAmdRocmTarget(defaults.gemma.llamaRocmTarget);
  if (isRocmLlamaRuntimeProfile(llamaRuntimeProfile)) {
    return target ?? undefined;
  }
  return target ?? undefined;
}

const NVIDIA_INCOMPATIBLE_FLUX_BACKENDS = new Set([
  "zluda-native",
  "zluda",
  "python-rocm",
  "rocm",
  "hip",
  "amd",
]);

export function resolveStoredFluxBackend(
  inpainting: Record<string, unknown> | null,
  defaults: AppSettings,
): FluxBackend {
  const rawRequested = String(inpainting?.fluxBackend ?? "")
    .trim()
    .toLowerCase();
  const requested = resolveFluxBackend(
    inpainting?.fluxBackend,
    defaults.inpainting?.fluxBackend ?? "cuda-native",
  );
  // Flux has no supported CPU fallback in the Apple Silicon Alpha. A setting
  // copied from Windows must never start a CUDA/ZLUDA/Python worker on macOS.
  if (process.platform === "darwin") {
    return "metal-native";
  }
  const hardwareVendor = inferHardwareVendorFromDefaults(defaults);
  if (hardwareVendor === "amd") {
    return resolveAmdStoredFluxBackend(requested, defaults);
  }
  if (hardwareVendor === "nvidia") {
    return resolveNvidiaStoredFluxBackend(rawRequested, requested, defaults);
  }
  return requested;
}

export function resolveStoredInpaintingModel(
  inpainting: Record<string, unknown> | null,
  defaults: AppSettings,
): InpaintingModel {
  return resolveInpaintingModel(
    inpainting?.model,
    defaults.inpainting?.model ?? "flux-klein",
  );
}

export function resolveStoredBubbleDetectionMode(
  inpainting: Record<string, unknown> | null,
  defaults: AppSettings,
): BubbleDetectionMode {
  return resolveBubbleDetectionMode(
    inpainting?.bubbleDetectionMode,
    defaults.inpainting?.bubbleDetectionMode ?? "auto",
  );
}

export function resolveStoredKoharuInpaintingBackend(
  inpainting: Record<string, unknown> | null,
  defaults: AppSettings,
): KoharuInpaintingBackend {
  const requested = resolveKoharuInpaintingBackend(
    inpainting?.koharuBackend,
    defaults.inpainting?.koharuBackend ?? "auto",
  );
  if (
    process.platform === "darwin" &&
    (requested === "cuda-native" || requested === "zluda-native")
  ) {
    return "auto";
  }
  return requested;
}

function resolveAmdStoredFluxBackend(
  requested: FluxBackend,
  defaults: AppSettings,
): FluxBackend {
  if (requested !== "cuda-native") {
    return requested;
  }
  const defaultBackend = defaults.inpainting?.fluxBackend;
  return defaultBackend === "python-cpu" ? "python-cpu" : "zluda-native";
}

function resolveNvidiaStoredFluxBackend(
  rawRequested: string,
  requested: FluxBackend,
  defaults: AppSettings,
): FluxBackend {
  if (NVIDIA_INCOMPATIBLE_FLUX_BACKENDS.has(rawRequested)) {
    return defaults.inpainting?.fluxBackend ?? "cuda-native";
  }
  return requested;
}

export function resolveStoredOcrGpuCudaTag(
  ocr: Record<string, unknown> | null,
  defaults: AppSettings,
): string {
  const defaultTag = defaults.ocr.gpuCudaTag ?? DEFAULT_OCR_GPU_CUDA_TAG;
  const stored = resolveOcrGpuCudaTag(ocr?.gpuCudaTag, defaultTag);
  if (
    defaultTag === RTX_50_OCR_GPU_CUDA_TAG &&
    (!ocr?.gpuCudaTag || stored === DEFAULT_OCR_GPU_CUDA_TAG)
  ) {
    return RTX_50_OCR_GPU_CUDA_TAG;
  }
  return stored;
}

const LEGACY_GEMMA_MODEL_REPO = "unsloth/gemma-4-26B-A4B-it-GGUF";

const LEGACY_GEMMA_MODEL_FILES = new Set([
  "gemma-4-26B-A4B-it-UD-Q3_K_XL.gguf",
  "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf",
  "gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf",
]);

export function resolveStoredGemmaModel(
  gemma: Record<string, unknown> | null,
  defaults: AppSettings,
  vramMode: GemmaVramMode = defaults.gemma.vramMode,
): GemmaModelSettings {
  const modelRepo = resolveNonEmptyString(
    gemma?.modelRepo,
    defaults.gemma.modelRepo,
  );
  const modelFile = resolveNonEmptyString(
    gemma?.modelFile,
    defaults.gemma.modelFile,
  );
  if (
    modelRepo === LEGACY_GEMMA_MODEL_REPO &&
    LEGACY_GEMMA_MODEL_FILES.has(modelFile)
  ) {
    return {
      modelRepo: defaults.gemma.modelRepo,
      modelFile: defaults.gemma.modelFile,
    };
  }
  const resolvedModel = { modelRepo, modelFile };
  if (isBuiltInGemmaModel(resolvedModel)) {
    const preset = getDefaultGemmaPresetForVramMode(vramMode);
    return {
      modelRepo: preset.modelRepo,
      modelFile: preset.modelFile,
    };
  }
  return resolvedModel;
}

export function resolveStoredGemmaMmproj(
  gemma: Record<string, unknown> | null,
  model: GemmaModelSettings,
  defaults: AppSettings,
): GemmaMmprojSettings {
  const storedMmprojRepo = resolveOptionalString(gemma?.mmprojRepo);
  const storedMmprojFile = resolveOptionalString(gemma?.mmprojFile);
  const builtInMmproj = getDefaultMmprojForGemmaModel(model);
  if (
    shouldUseBuiltInMmproj(storedMmprojRepo, storedMmprojFile, builtInMmproj)
  ) {
    return builtInMmproj;
  }
  if (hasStoredMmproj(storedMmprojRepo, storedMmprojFile)) {
    return resolveStoredMmprojFallback({
      storedMmprojRepo,
      storedMmprojFile,
      builtInMmproj,
      defaults,
    });
  }
  return builtInMmproj ?? {};
}

function shouldUseBuiltInMmproj(
  storedMmprojRepo: string | undefined,
  storedMmprojFile: string | undefined,
  builtInMmproj: GemmaMmprojSettings | undefined,
): builtInMmproj is GemmaMmprojSettings {
  return Boolean(
    builtInMmproj &&
    (!storedMmprojRepo ||
      !storedMmprojFile ||
      isBuiltInGemmaMmproj(storedMmprojRepo, storedMmprojFile)),
  );
}

function hasStoredMmproj(
  storedMmprojRepo: string | undefined,
  storedMmprojFile: string | undefined,
): boolean {
  return Boolean(storedMmprojRepo || storedMmprojFile);
}

function resolveStoredMmprojFallback({
  storedMmprojRepo,
  storedMmprojFile,
  builtInMmproj,
  defaults,
}: {
  storedMmprojRepo: string | undefined;
  storedMmprojFile: string | undefined;
  builtInMmproj: GemmaMmprojSettings | undefined;
  defaults: AppSettings;
}): GemmaMmprojSettings {
  return {
    mmprojRepo:
      storedMmprojRepo ??
      defaults.gemma.mmprojRepo ??
      builtInMmproj?.mmprojRepo ??
      DEFAULT_GEMMA_MMPROJ_REPO,
    mmprojFile:
      storedMmprojFile ??
      defaults.gemma.mmprojFile ??
      builtInMmproj?.mmprojFile ??
      DEFAULT_GEMMA_MMPROJ_FILE,
  };
}
