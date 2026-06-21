import {
  DEFAULT_API_BASE_URL,
  DEFAULT_API_CUSTOM_HEADERS_JSON,
  DEFAULT_API_EXTRA_BODY_JSON,
  DEFAULT_API_MODEL,
  DEFAULT_API_REASONING_EFFORT,
  DEFAULT_API_TEMPERATURE,
  DEFAULT_API_TOP_K,
  DEFAULT_API_TOP_P,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_OAUTH_PORT,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CONTEXT_TOKENS,
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
  resolveContextTokens,
  resolveFluxBackend,
  resolveGemmaVramMode,
  resolveMaxTokens,
  resolveModelProvider,
  resolveNullableIntegerRange,
  resolveNullableNumberRange,
  resolveNullableReasoningEffort,
  resolveNonEmptyString,
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOpenAiCompatibleBaseUrl,
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
    api: {
      baseUrl: resolveOpenAiCompatibleBaseUrl(
        env.MANGA_TRANSLATOR_API_BASE_URL,
        DEFAULT_API_BASE_URL,
      ),
      model: resolveNonEmptyString(
        env.MANGA_TRANSLATOR_API_MODEL,
        DEFAULT_API_MODEL,
      ),
      temperature: resolveNullableNumberRange(
        env.MANGA_TRANSLATOR_API_TEMPERATURE,
        DEFAULT_API_TEMPERATURE,
        0,
        2,
      ),
      topP: resolveNullableNumberRange(
        env.MANGA_TRANSLATOR_API_TOP_P,
        DEFAULT_API_TOP_P,
        0,
        1,
      ),
      topK: resolveNullableIntegerRange(
        env.MANGA_TRANSLATOR_API_TOP_K,
        DEFAULT_API_TOP_K,
        1,
        1000,
      ),
      reasoningEffort: resolveNullableReasoningEffort(
        env.MANGA_TRANSLATOR_API_REASONING_EFFORT,
        DEFAULT_API_REASONING_EFFORT,
      ),
      extraBodyJson:
        env.MANGA_TRANSLATOR_API_EXTRA_BODY ?? DEFAULT_API_EXTRA_BODY_JSON,
      customHeadersJson:
        env.MANGA_TRANSLATOR_API_HEADERS ?? DEFAULT_API_CUSTOM_HEADERS_JSON,
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
      twoPassByDefault: true,
      analysisScopeDefault: "missing",
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
    ctx: resolveContextTokens(env.MANGA_TRANSLATOR_CTX, DEFAULT_CONTEXT_TOKENS),
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

  const ocrGpuBackend = resolveHardwareOcrGpuBackend(info);
  const memoryMb = info.memoryMb ?? 0;
  const supportsNvidiaOcrGpu =
    !isAmd && (supportedRtxGeneration || supportedComputeCapability);
  const ocrDevice: OcrDevice =
    memoryMb >= 8000 &&
    (supportsNvidiaOcrGpu || ocrGpuBackend === "rocm-transformers")
      ? "gpu"
      : "cpu";
  const ocrGpuCudaTag = resolveHardwareOcrGpuCudaTag(info);
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
  info: DetectedGpuInfo | null,
): OcrGpuBackend {
  if (info?.vendor === "amd" && (info.supportsRocm || info.rocmTarget)) {
    return "rocm-transformers";
  }
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
