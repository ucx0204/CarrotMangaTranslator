import {
  DEFAULT_GEMMA_MMPROJ_FILE,
  DEFAULT_GEMMA_MMPROJ_REPO,
  DEFAULT_OCR_GPU_CUDA_TAG,
  RTX_50_OCR_GPU_CUDA_TAG,
} from "../../shared/modelPresets";
import type {
  AmdRocmTarget,
  AppSettings,
  FluxBackend,
  GemmaVramMode,
  LlamaRuntimeProfile,
} from "../../shared/types";
import { normalizeAmdRocmTarget } from "../gpuInfo";
import {
  asRecord,
  inferHardwareVendorFromDefaults,
  resolveBoolean,
  resolveCodexReasoningEffort,
  resolveFluxBackend,
  resolveGemmaVramMode,
  resolveMaxTokens,
  resolveModelProvider,
  resolveModelSource,
  resolveNonEmptyString,
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOptionalString,
  resolvePortNumber,
} from "./appSettingsResolvers";
import { resolveDefaultAppSettings } from "./appSettingsDefaults";
import {
  getDefaultGemmaPresetForVramMode,
  getDefaultMmprojForGemmaModel,
  getModeAwareGemmaDefaults,
  isBuiltInGemmaMmproj,
  isBuiltInGemmaModel,
} from "./gemmaModelPresets";
import {
  isAmdLlamaRuntimeProfile,
  isNvidiaLlamaRuntimeProfile,
  isRocmLlamaRuntimeProfile,
  resolveLlamaRuntimeProfile,
} from "./llamaRuntimeProfile";

export function normalizeAppSettings(
  raw: unknown,
  defaults = resolveDefaultAppSettings(),
): AppSettings {
  const record = asRecord(raw);
  const gemma = record?.gemma;
  const codex = record?.codex;
  const ocr = record?.ocr;
  const ui = asRecord(record?.ui);
  const inpainting = asRecord(record?.inpainting);
  const modelSource = resolveModelSource(
    asRecord(gemma)?.modelSource,
    defaults.gemma.modelSource,
  );
  const resolvedVramMode = resolveGemmaVramMode(
    asRecord(gemma)?.vramMode,
    defaults.gemma.vramMode,
  );
  const modeAwareGemmaDefaults = getModeAwareGemmaDefaults(
    defaults,
    resolvedVramMode,
  );
  const modeDefaults = {
    ...defaults,
    gemma: {
      ...defaults.gemma,
      ...modeAwareGemmaDefaults,
    },
  };
  const resolvedModel = resolveStoredGemmaModel(
    asRecord(gemma),
    modeDefaults,
    resolvedVramMode,
  );
  const resolvedMmproj =
    modelSource === "huggingface"
      ? resolveStoredGemmaMmproj(asRecord(gemma), resolvedModel, modeDefaults)
      : {};
  const localModelPath = resolveOptionalString(asRecord(gemma)?.localModelPath);
  const localMmprojPath = resolveOptionalString(
    asRecord(gemma)?.localMmprojPath,
  );
  const llamaRuntimeProfile = resolveStoredLlamaRuntimeProfile(
    asRecord(gemma),
    defaults,
  );
  const llamaRocmTarget = resolveStoredLlamaRocmTarget(
    asRecord(gemma),
    defaults,
    llamaRuntimeProfile,
  );
  const resolvedOcr = asRecord(ocr);
  const hardwareVendor = inferHardwareVendorFromDefaults(defaults);
  const ocrGpuBackend = resolveOcrGpuBackend(
    resolvedOcr?.gpuBackend,
    defaults.ocr.gpuBackend ?? "cuda",
  );
  const ocrDevice =
    hardwareVendor === "amd" && ocrGpuBackend !== "rocm-transformers"
      ? "cpu"
      : resolveOcrDevice(resolvedOcr?.device, defaults.ocr.device);
  return {
    modelProvider: resolveModelProvider(
      record?.modelProvider,
      defaults.modelProvider,
    ),
    gemma: {
      modelSource,
      modelRepo: resolvedModel.modelRepo,
      modelFile: resolvedModel.modelFile,
      ...(resolvedMmproj.mmprojRepo
        ? { mmprojRepo: resolvedMmproj.mmprojRepo }
        : {}),
      ...(resolvedMmproj.mmprojFile
        ? { mmprojFile: resolvedMmproj.mmprojFile }
        : {}),
      ...(localModelPath ? { localModelPath } : {}),
      ...(localMmprojPath ? { localMmprojPath } : {}),
      vramMode: resolvedVramMode,
      llamaRuntimeProfile,
      ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
    },
    codex: {
      model: resolveNonEmptyString(
        asRecord(codex)?.model,
        defaults.codex.model,
      ),
      reasoningEffort: resolveCodexReasoningEffort(
        asRecord(codex)?.reasoningEffort,
        defaults.codex.reasoningEffort,
      ),
      oauthPort: resolvePortNumber(
        asRecord(codex)?.oauthPort,
        defaults.codex.oauthPort,
      ),
    },
    ocr: {
      device: ocrDevice,
      gpuBackend: ocrGpuBackend,
      gpuCudaTag: resolveStoredOcrGpuCudaTag(resolvedOcr, defaults),
    },
    ui: {
      inpaintingGuideHidden: resolveBoolean(
        ui?.inpaintingGuideHidden,
        defaults.ui?.inpaintingGuideHidden ?? false,
      ),
    },
    inpainting: {
      fluxBackend: resolveStoredFluxBackend(inpainting, defaults),
    },
    maxTokens: resolveMaxTokens(record?.maxTokens, defaults.maxTokens),
  };
}

export function parseStoredAppSettings(
  rawText: string | null | undefined,
  defaults = resolveDefaultAppSettings(),
): AppSettings {
  if (!rawText?.trim()) {
    return defaults;
  }

  return normalizeAppSettings(JSON.parse(rawText), defaults);
}

function resolveStoredLlamaRuntimeProfile(
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
  return requested;
}

function resolveStoredLlamaRocmTarget(
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

function resolveStoredFluxBackend(
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
  const hardwareVendor = inferHardwareVendorFromDefaults(defaults);
  if (hardwareVendor === "amd" && requested === "cuda-native") {
    const defaultBackend = defaults.inpainting?.fluxBackend;
    return defaultBackend === "python-cpu" ? "python-cpu" : "zluda-native";
  }
  if (
    hardwareVendor === "nvidia" &&
    ["zluda-native", "zluda", "python-rocm", "rocm", "hip", "amd"].includes(
      rawRequested,
    )
  ) {
    return defaults.inpainting?.fluxBackend ?? "cuda-native";
  }
  return requested;
}

function resolveStoredOcrGpuCudaTag(
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

function resolveStoredGemmaModel(
  gemma: Record<string, unknown> | null,
  defaults: AppSettings,
  vramMode: GemmaVramMode = defaults.gemma.vramMode,
): Pick<AppSettings["gemma"], "modelRepo" | "modelFile"> {
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

function resolveStoredGemmaMmproj(
  gemma: Record<string, unknown> | null,
  model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">,
  defaults: AppSettings,
): Pick<AppSettings["gemma"], "mmprojRepo" | "mmprojFile"> {
  const storedMmprojRepo = resolveOptionalString(gemma?.mmprojRepo);
  const storedMmprojFile = resolveOptionalString(gemma?.mmprojFile);
  const builtInMmproj = getDefaultMmprojForGemmaModel(model);
  if (
    builtInMmproj &&
    (!storedMmprojRepo ||
      !storedMmprojFile ||
      isBuiltInGemmaMmproj(storedMmprojRepo, storedMmprojFile))
  ) {
    return builtInMmproj;
  }
  if (storedMmprojRepo || storedMmprojFile) {
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
  if (builtInMmproj) {
    return builtInMmproj;
  }
  return {};
}
