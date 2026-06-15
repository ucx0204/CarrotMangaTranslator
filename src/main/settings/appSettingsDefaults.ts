import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_OAUTH_PORT,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_SOURCE,
  DEFAULT_OCR_GPU_CUDA_TAG,
  RTX_50_OCR_GPU_CUDA_TAG,
} from "../../shared/modelPresets";
import type {
  AmdRocmTarget,
  AppSettings,
  FluxBackend,
  GemmaVramMode,
  LlamaRuntimeProfile,
  ModelProvider,
  OcrDevice,
  OcrGpuBackend,
} from "../../shared/types";
import type { DetectedGpuInfo } from "../gpuInfo";
import {
  normalizeAmdRocmTarget,
  resolveAmdRocmTargetFromInfo,
} from "../gpuInfo";
import { getDefaultGemmaPresetForVramMode } from "./gemmaModelPresets";
import {
  resolveCodexReasoningEffort,
  resolveFluxBackend,
  resolveGemmaVramMode,
  resolveMaxTokens,
  resolveModelProvider,
  resolveNonEmptyString,
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOptionalString,
  resolvePortNumber,
} from "./appSettingsResolvers";
import {
  resolveHardwareLlamaRuntimeProfile,
  resolveLlamaRuntimeProfile,
} from "./llamaRuntimeProfile";

const GEMMA_MINIMUM_VRAM_MB = 8000;
const GEMMA_ECONOMY_VRAM_MB = 16000;
const GEMMA_FULL_VRAM_MB = 24000;
const GEMMA_MINIMUM_COMPUTE_CAPABILITY = 7.5;
const GEMMA_MINIMUM_RTX_GENERATION = 20;

export function resolveDefaultAppSettings(
  env: NodeJS.ProcessEnv = process.env,
  detectedGpu?: number | DetectedGpuInfo | null,
): AppSettings {
  const hardwareDefaults = resolveHardwareDefaults(detectedGpu);
  const vramMode = resolveGemmaVramMode(
    env.MANGA_TRANSLATOR_GEMMA_VRAM_MODE,
    hardwareDefaults.gemmaVramMode,
  );
  const defaultGemmaPreset = getDefaultGemmaPresetForVramMode(vramMode);
  const llamaRuntimeProfile = resolveLlamaRuntimeProfile(
    env,
    hardwareDefaults.llamaRuntimeProfile,
  );
  const llamaRocmTarget =
    normalizeAmdRocmTarget(
      env.MANGA_TRANSLATOR_AMD_ROCM_TARGET ?? env.MANGA_TRANSLATOR_AMD_GFX_ARCH,
    ) ?? hardwareDefaults.llamaRocmTarget;
  return {
    modelProvider: resolveModelProvider(
      env.MANGA_TRANSLATOR_MODEL_PROVIDER,
      hardwareDefaults.modelProvider,
    ),
    gemma: {
      modelSource: DEFAULT_MODEL_SOURCE,
      modelRepo: resolveNonEmptyString(
        env.MANGA_TRANSLATOR_MODEL_HF,
        defaultGemmaPreset.modelRepo,
      ),
      modelFile: resolveNonEmptyString(
        env.LLAMA_ARG_HF_FILE,
        defaultGemmaPreset.modelFile,
      ),
      mmprojRepo:
        resolveOptionalString(env.MANGA_TRANSLATOR_MMPROJ_HF) ??
        defaultGemmaPreset.mmprojRepo,
      mmprojFile:
        resolveOptionalString(env.LLAMA_ARG_MMPROJ_FILE) ??
        defaultGemmaPreset.mmprojFile,
      vramMode,
      llamaRuntimeProfile,
      ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
    },
    codex: {
      model: resolveNonEmptyString(
        env.MANGA_TRANSLATOR_CODEX_MODEL,
        DEFAULT_CODEX_MODEL,
      ),
      reasoningEffort: resolveCodexReasoningEffort(
        env.MANGA_TRANSLATOR_CODEX_REASONING_EFFORT,
        DEFAULT_CODEX_REASONING_EFFORT,
      ),
      oauthPort: resolvePortNumber(
        env.MANGA_TRANSLATOR_CODEX_OAUTH_PORT,
        DEFAULT_CODEX_OAUTH_PORT,
      ),
    },
    ocr: {
      device: resolveOcrDevice(
        env.MANGA_TRANSLATOR_OCR_DEVICE,
        hardwareDefaults.ocrDevice,
      ),
      gpuBackend: resolveOcrGpuBackend(
        env.MANGA_TRANSLATOR_OCR_GPU_BACKEND,
        hardwareDefaults.ocrGpuBackend,
      ),
      gpuCudaTag: resolveOcrGpuCudaTag(
        env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG ??
          env.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG ??
          env.MANGA_TRANSLATOR_OCR_GPU_CUDA,
        hardwareDefaults.ocrGpuCudaTag,
      ),
    },
    ui: {
      inpaintingGuideHidden: false,
    },
    inpainting: {
      fluxBackend: resolveFluxBackend(
        env.MANGA_TRANSLATOR_FLUX_BACKEND ?? env.MGT_FLUX_BACKEND,
        hardwareDefaults.fluxBackend,
      ),
    },
    maxTokens: resolveMaxTokens(
      env.MANGA_TRANSLATOR_MAX_TOKENS,
      DEFAULT_MAX_TOKENS,
    ),
  };
}

export function resolveHardwareDefaults(
  detectedGpu?: number | DetectedGpuInfo | null,
): {
  modelProvider: ModelProvider;
  gemmaVramMode: GemmaVramMode;
  ocrDevice: OcrDevice;
  ocrGpuCudaTag: string;
  ocrGpuBackend: OcrGpuBackend;
  llamaRuntimeProfile: LlamaRuntimeProfile;
  llamaRocmTarget?: AmdRocmTarget;
  fluxBackend: FluxBackend;
} {
  const info = normalizeDetectedGpuInfo(detectedGpu);
  const isAmd = info?.vendor === "amd";
  const supportedRtxGeneration =
    (info?.rtxGeneration ?? 0) >= GEMMA_MINIMUM_RTX_GENERATION;
  const supportedComputeCapability =
    (info?.computeCapability ?? 0) >= GEMMA_MINIMUM_COMPUTE_CAPABILITY;
  const supportedAmdGpu =
    isAmd && Boolean(info?.supportsVulkan || info?.supportsRocm);
  const llamaRocmTarget = resolveHardwareLlamaRocmTarget(info);
  const supportsGemma =
    !!info?.memoryMb &&
    info.memoryMb >= GEMMA_MINIMUM_VRAM_MB &&
    (supportedRtxGeneration || supportedComputeCapability || supportedAmdGpu);
  if (!supportsGemma) {
    return {
      modelProvider: "openai-codex",
      gemmaVramMode: "minimum12b",
      ocrDevice: "cpu",
      ocrGpuCudaTag: resolveHardwareOcrGpuCudaTag(info),
      ocrGpuBackend: resolveHardwareOcrGpuBackend(info),
      llamaRuntimeProfile: resolveHardwareLlamaRuntimeProfile(info),
      ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
      fluxBackend: resolveHardwareFluxBackend(info),
    };
  }

  const memoryMb = info.memoryMb ?? 0;
  const ocrDevice: OcrDevice = isAmd
    ? "cpu"
    : memoryMb >= 12000
      ? "gpu"
      : "cpu";
  const ocrGpuCudaTag = resolveHardwareOcrGpuCudaTag(info);
  const ocrGpuBackend = resolveHardwareOcrGpuBackend(info);
  const llamaRuntimeProfile = resolveHardwareLlamaRuntimeProfile(info);
  if (memoryMb >= GEMMA_FULL_VRAM_MB) {
    return {
      modelProvider: "gemma",
      gemmaVramMode: "full31b",
      ocrDevice,
      ocrGpuCudaTag,
      ocrGpuBackend,
      llamaRuntimeProfile,
      ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
      fluxBackend: resolveHardwareFluxBackend(info),
    };
  }
  if (memoryMb >= GEMMA_ECONOMY_VRAM_MB) {
    return {
      modelProvider: "gemma",
      gemmaVramMode: "economy26b",
      ocrDevice,
      ocrGpuCudaTag,
      ocrGpuBackend,
      llamaRuntimeProfile,
      ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
      fluxBackend: resolveHardwareFluxBackend(info),
    };
  }
  return {
    modelProvider: "gemma",
    gemmaVramMode: "minimum12b",
    ocrDevice,
    ocrGpuCudaTag,
    ocrGpuBackend,
    llamaRuntimeProfile,
    ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
    fluxBackend: resolveHardwareFluxBackend(info),
  };
}

function resolveHardwareOcrGpuCudaTag(info: DetectedGpuInfo | null): string {
  if (info?.vendor === "amd") {
    return DEFAULT_OCR_GPU_CUDA_TAG;
  }
  if (
    (info?.computeCapability ?? 0) >= 12 ||
    (info?.rtxGeneration ?? 0) >= 50
  ) {
    return RTX_50_OCR_GPU_CUDA_TAG;
  }
  return DEFAULT_OCR_GPU_CUDA_TAG;
}

function resolveHardwareOcrGpuBackend(
  _info: DetectedGpuInfo | null,
): OcrGpuBackend {
  return "cuda";
}

function resolveHardwareLlamaRocmTarget(
  info: DetectedGpuInfo | null,
): AmdRocmTarget | undefined {
  if (info?.vendor !== "amd") {
    return undefined;
  }
  return resolveAmdRocmTargetFromInfo(info) ?? undefined;
}

function resolveHardwareFluxBackend(info: DetectedGpuInfo | null): FluxBackend {
  if (info?.vendor !== "amd") {
    return "cuda-native";
  }
  return "zluda-native";
}

function normalizeDetectedGpuInfo(
  value?: number | DetectedGpuInfo | null,
): DetectedGpuInfo | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0
      ? {
          name: null,
          memoryMb: value,
          rtxGeneration: null,
          computeCapability: null,
          vendor: "unknown",
        }
      : null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const memoryMb =
    typeof value.memoryMb === "number" && Number.isFinite(value.memoryMb)
      ? value.memoryMb
      : null;
  const rtxGeneration =
    typeof value.rtxGeneration === "number" &&
    Number.isFinite(value.rtxGeneration)
      ? value.rtxGeneration
      : null;
  const computeCapability =
    typeof value.computeCapability === "number" &&
    Number.isFinite(value.computeCapability)
      ? value.computeCapability
      : null;
  const normalized: DetectedGpuInfo = {
    name: typeof value.name === "string" ? value.name : null,
    memoryMb,
    rtxGeneration,
    computeCapability,
    vendor:
      value.vendor === "nvidia" || value.vendor === "amd"
        ? value.vendor
        : "unknown",
    rocmArch: typeof value.rocmArch === "string" ? value.rocmArch : null,
    rocmTarget: normalizeAmdRocmTarget(value.rocmTarget),
    supportsRocm:
      typeof value.supportsRocm === "boolean" ? value.supportsRocm : false,
    supportsVulkan:
      typeof value.supportsVulkan === "boolean"
        ? value.supportsVulkan
        : value.vendor === "amd",
  };
  const inferredRocmTarget = resolveAmdRocmTargetFromInfo(normalized);
  return {
    ...normalized,
    rocmTarget: inferredRocmTarget,
    supportsRocm: normalized.supportsRocm || Boolean(inferredRocmTarget),
  };
}
