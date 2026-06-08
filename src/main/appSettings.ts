import type {
  AppSettings,
  AmdRocmTarget,
  CodexReasoningEffort,
  FluxBackend,
  GemmaVramMode,
  LlamaRuntimeProfile,
  JobPhase,
  ModelProvider,
  ModelSource,
  OcrDevice,
  OcrGpuBackend
} from "../shared/types";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_OAUTH_PORT,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_GEMMA_MMPROJ_FILE,
  DEFAULT_GEMMA_MMPROJ_REPO,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_SOURCE,
  DEFAULT_OCR_GPU_CUDA_TAG,
  GEMMA_12B_MMPROJ_FILE,
  GEMMA_12B_MMPROJ_REPO,
  GEMMA_12B_MODEL_FILE_Q4_K_M,
  GEMMA_12B_MODEL_REPO,
  GEMMA_26B_MMPROJ_FILE,
  GEMMA_26B_MMPROJ_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  GEMMA_26B_MODEL_REPO,
  GEMMA_31B_MMPROJ_FILE,
  GEMMA_31B_MMPROJ_REPO,
  GEMMA_31B_MODEL_FILE_IQ3_S,
  GEMMA_31B_MODEL_REPO,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  RTX_50_OCR_GPU_CUDA_TAG
} from "../shared/modelPresets";
import type { DetectedGpuInfo } from "./gpuInfo";
import { normalizeAmdRocmTarget, resolveAmdRocmTargetFromInfo } from "./gpuInfo";
import { DEFAULT_IMAGE_TOKENS, GEMMA_RUNTIME_PRESETS } from "./settings/gemmaRuntimePresets";
import {
  isRtx50LlamaRuntimeProfile,
  isRocmLlamaRuntimeProfile,
  isVulkanLlamaRuntimeProfile,
  resolveHardwareLlamaRuntimeProfile,
  resolveLlamaRuntimeProfile
} from "./settings/llamaRuntimeProfile";
import { readBooleanLikeEnv, readNumberEnv, readOptionalBooleanEnv, readOptionalNumberEnv } from "./settings/envSettings";
import { join } from "node:path";

export {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_OAUTH_PORT,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_GEMMA_MMPROJ_FILE,
  DEFAULT_GEMMA_MMPROJ_REPO,
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_FILE_IQ3_S,
  DEFAULT_GEMMA_MODEL_REPO,
  DEFAULT_GEMMA_VRAM_MODE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_PROVIDER,
  DEFAULT_MODEL_SOURCE,
  DEFAULT_OCR_DEVICE,
  DEFAULT_OCR_GPU_CUDA_TAG,
  GEMMA_12B_MMPROJ_FILE,
  GEMMA_12B_MMPROJ_REPO,
  GEMMA_12B_MODEL_FILE_Q4_K_M,
  GEMMA_12B_MODEL_REPO,
  GEMMA_26B_MMPROJ_FILE,
  GEMMA_26B_MMPROJ_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  GEMMA_26B_MODEL_REPO,
  GEMMA_31B_MMPROJ_FILE,
  GEMMA_31B_MMPROJ_REPO,
  GEMMA_31B_MODEL_FILE_IQ3_S,
  GEMMA_31B_MODEL_REPO,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  RTX_50_OCR_GPU_CUDA_TAG
} from "../shared/modelPresets";
const BEELLAMA_LLAMA_RUNTIME_DIR_CUDA12 = "beellama-v0.2.0-cuda12.4";
const BEELLAMA_LLAMA_RUNTIME_DIR_CUDA13 = "beellama-v0.2.0-cuda13.1";
const MAINLINE_LLAMA_RUNTIME_DIR_CUDA12 = "llama-b9547-cuda12.4";
const MAINLINE_LLAMA_RUNTIME_DIR_CUDA13 = "llama-b9547-cuda13.3";
const LEMONADE_LLAMA_RUNTIME_ROCM_RELEASE = "b1291";
const MAINLINE_LLAMA_RUNTIME_DIR_VULKAN = "llama-b9547-vulkan";
const GEMMA_MINIMUM_VRAM_MB = 8000;
const GEMMA_ECONOMY_VRAM_MB = 16000;
const GEMMA_FULL_VRAM_MB = 24000;
const GEMMA_MINIMUM_COMPUTE_CAPABILITY = 7.5;
const GEMMA_MINIMUM_RTX_GENERATION = 20;

export type TranslationOptions = {
  imagePath: string;
  imageWidth?: number;
  imageHeight?: number;
  outputDir: string;
  modelProvider: ModelProvider;
  port: number;
  promptMode: string;
  promptOverrideText?: string;
  temperature: number;
  topP: number;
  topK: number;
  maxTokens: number;
  ctx: number;
  batch: number;
  ubatch: number;
  gemmaVramMode: GemmaVramMode;
  fitTargetMb: number;
  gpuLayers?: number | "fit";
  cacheTypeK?: string;
  cacheTypeV?: string;
  ctxCheckpoints?: number;
  kvOffload?: boolean;
  mmprojOffload?: boolean;
  threads?: number;
  threadsBatch?: number;
  poll?: number;
  pollBatch?: boolean;
  prioBatch?: number;
  cacheIdleSlots?: boolean;
  cacheReuse?: number;
  enableMetrics?: boolean;
  enablePerf?: boolean;
  draftModelRepo?: string;
  draftModelFile?: string;
  useDraft?: boolean;
  imageMinTokens: number;
  imageMaxTokens: number;
  includeEnhancedVariant: boolean;
  enhancedMaxLongSide: number;
  enhancedContrast: number;
  imageFirst: boolean;
  reuseServer: boolean;
  llamaRuntimeProfile?: string;
  llamaRocmTarget?: string;
  workingDir: string;
  toolsDir: string;
  ocrRuntimeDir?: string;
  serverPath: string;
  modelSource: ModelSource;
  modelRepo: string;
  modelFile: string;
  mmprojRepo?: string;
  mmprojFile?: string;
  localModelPath?: string;
  localMmprojPath?: string;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  codexOauthPort: number;
  ocrDevice: OcrDevice;
  ocrGpuBackend?: OcrGpuBackend;
  ocrGpuCudaTag?: string;
  ocrBboxProvider?: string;
  ocrBboxCommand?: string;
  ocrBboxHintsPath?: string;
  ocrBboxHints?: unknown;
  ocrBboxResult?: {
    hints?: unknown[];
    diagnostics?: unknown[];
    noTextDetected?: boolean;
    textEvidenceCount?: number;
  };
  skipOcrBboxHints?: boolean;
  regionCropMode?: boolean;
  ocrPageIndex?: number;
  ocrPageTotal?: number;
  ocrProgressDefaultToPage?: boolean;
  ocrBatchCompletedBefore?: number;
  ocrBatchTotal?: number;
  onProgress?: (event: {
    phase: JobPhase;
    progressText: string;
    detail?: string;
    progressCurrent?: number;
    progressTotal?: number;
    pageIndex?: number | null;
    pageTotal?: number | null;
    progressMode?: "determinate" | "indeterminate" | "log-only";
    progressPercent?: number;
    progressBytes?: number;
    progressTotalBytes?: number;
    progressBytesPerSecond?: number;
    installLogLine?: string;
  }) => void;
  hfHomeDir?: string;
  hfHubCacheDir?: string;
  llamaCacheDir?: string;
  label: string;
  abortSignal?: AbortSignal;
};

export type TranslationOptionPaths = {
  isPackaged?: boolean;
  dataRoot: string;
  toolsDir: string;
  ocrRuntimeDir?: string;
  llamaServerPath: string;
  hfHomeDir?: string;
  hfHubCacheDir?: string;
  llamaCacheDir?: string;
};

export function resolveDefaultAppSettings(
  env: NodeJS.ProcessEnv = process.env,
  detectedGpu?: number | DetectedGpuInfo | null
): AppSettings {
  const hardwareDefaults = resolveHardwareDefaults(detectedGpu);
  const vramMode = resolveGemmaVramMode(env.MANGA_TRANSLATOR_GEMMA_VRAM_MODE, hardwareDefaults.gemmaVramMode);
  const defaultGemmaPreset = getDefaultGemmaPresetForVramMode(vramMode);
  const llamaRuntimeProfile = resolveLlamaRuntimeProfile(env, hardwareDefaults.llamaRuntimeProfile);
  const llamaRocmTarget =
    normalizeAmdRocmTarget(env.MANGA_TRANSLATOR_AMD_ROCM_TARGET ?? env.MANGA_TRANSLATOR_AMD_GFX_ARCH) ??
    hardwareDefaults.llamaRocmTarget;
  return {
    modelProvider: resolveModelProvider(env.MANGA_TRANSLATOR_MODEL_PROVIDER, hardwareDefaults.modelProvider),
    gemma: {
      modelSource: DEFAULT_MODEL_SOURCE,
      modelRepo: resolveNonEmptyString(env.MANGA_TRANSLATOR_MODEL_HF, defaultGemmaPreset.modelRepo),
      modelFile: resolveNonEmptyString(env.LLAMA_ARG_HF_FILE, defaultGemmaPreset.modelFile),
      mmprojRepo: resolveOptionalString(env.MANGA_TRANSLATOR_MMPROJ_HF) ?? defaultGemmaPreset.mmprojRepo,
      mmprojFile: resolveOptionalString(env.LLAMA_ARG_MMPROJ_FILE) ?? defaultGemmaPreset.mmprojFile,
      vramMode,
      llamaRuntimeProfile,
      ...(llamaRocmTarget ? { llamaRocmTarget } : {})
    },
    codex: {
      model: resolveNonEmptyString(env.MANGA_TRANSLATOR_CODEX_MODEL, DEFAULT_CODEX_MODEL),
      reasoningEffort: resolveCodexReasoningEffort(
        env.MANGA_TRANSLATOR_CODEX_REASONING_EFFORT,
        DEFAULT_CODEX_REASONING_EFFORT
      ),
      oauthPort: resolvePortNumber(env.MANGA_TRANSLATOR_CODEX_OAUTH_PORT, DEFAULT_CODEX_OAUTH_PORT)
    },
    ocr: {
      device: resolveOcrDevice(env.MANGA_TRANSLATOR_OCR_DEVICE, hardwareDefaults.ocrDevice),
      gpuBackend: resolveOcrGpuBackend(env.MANGA_TRANSLATOR_OCR_GPU_BACKEND, hardwareDefaults.ocrGpuBackend),
      gpuCudaTag: resolveOcrGpuCudaTag(
        env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG ??
          env.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG ??
          env.MANGA_TRANSLATOR_OCR_GPU_CUDA,
        hardwareDefaults.ocrGpuCudaTag
      )
    },
    ui: {
      inpaintingGuideHidden: false
    },
    inpainting: {
      fluxBackend: resolveFluxBackend(
        env.MANGA_TRANSLATOR_FLUX_BACKEND ?? env.MGT_FLUX_BACKEND,
        hardwareDefaults.fluxBackend
      )
    },
    maxTokens: resolveMaxTokens(env.MANGA_TRANSLATOR_MAX_TOKENS, DEFAULT_MAX_TOKENS)
  };
}

export function resolveHardwareDefaults(
  detectedGpu?: number | DetectedGpuInfo | null
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
  const supportedRtxGeneration = (info?.rtxGeneration ?? 0) >= GEMMA_MINIMUM_RTX_GENERATION;
  const supportedComputeCapability = (info?.computeCapability ?? 0) >= GEMMA_MINIMUM_COMPUTE_CAPABILITY;
  const supportedAmdGpu = isAmd && Boolean(info?.supportsVulkan || info?.supportsRocm);
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
      fluxBackend: resolveHardwareFluxBackend(info)
    };
  }

  const memoryMb = info.memoryMb ?? 0;
  const ocrDevice: OcrDevice = isAmd ? "cpu" : memoryMb >= 12000 ? "gpu" : "cpu";
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
      fluxBackend: resolveHardwareFluxBackend(info)
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
      fluxBackend: resolveHardwareFluxBackend(info)
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
    fluxBackend: resolveHardwareFluxBackend(info)
  };
}

export function normalizeAppSettings(raw: unknown, defaults = resolveDefaultAppSettings()): AppSettings {
  const record = asRecord(raw);
  const gemma = record?.gemma;
  const codex = record?.codex;
  const ocr = record?.ocr;
  const ui = asRecord(record?.ui);
  const inpainting = asRecord(record?.inpainting);
  const modelSource = resolveModelSource(asRecord(gemma)?.modelSource, defaults.gemma.modelSource);
  const resolvedVramMode = resolveGemmaVramMode(asRecord(gemma)?.vramMode, defaults.gemma.vramMode);
  const modeAwareGemmaDefaults = getModeAwareGemmaDefaults(defaults, resolvedVramMode);
  const modeDefaults = {
    ...defaults,
    gemma: {
      ...defaults.gemma,
      ...modeAwareGemmaDefaults
    }
  };
  const resolvedModel = resolveStoredGemmaModel(asRecord(gemma), modeDefaults, resolvedVramMode);
  const resolvedMmproj =
    modelSource === "huggingface" ? resolveStoredGemmaMmproj(asRecord(gemma), resolvedModel, modeDefaults) : {};
  const localModelPath = resolveOptionalString(asRecord(gemma)?.localModelPath);
  const localMmprojPath = resolveOptionalString(asRecord(gemma)?.localMmprojPath);
  const llamaRocmTarget = normalizeAmdRocmTarget(asRecord(gemma)?.llamaRocmTarget ?? defaults.gemma.llamaRocmTarget);
  const resolvedOcr = asRecord(ocr);
  return {
    modelProvider: resolveModelProvider(record?.modelProvider, defaults.modelProvider),
    gemma: {
      modelSource,
      modelRepo: resolvedModel.modelRepo,
      modelFile: resolvedModel.modelFile,
      ...(resolvedMmproj.mmprojRepo ? { mmprojRepo: resolvedMmproj.mmprojRepo } : {}),
      ...(resolvedMmproj.mmprojFile ? { mmprojFile: resolvedMmproj.mmprojFile } : {}),
      ...(localModelPath ? { localModelPath } : {}),
      ...(localMmprojPath ? { localMmprojPath } : {}),
      vramMode: resolvedVramMode,
      llamaRuntimeProfile: resolveLlamaRuntimeProfile({}, asRecord(gemma)?.llamaRuntimeProfile ?? defaults.gemma.llamaRuntimeProfile),
      ...(llamaRocmTarget ? { llamaRocmTarget } : {})
    },
    codex: {
      model: resolveNonEmptyString(asRecord(codex)?.model, defaults.codex.model),
      reasoningEffort: resolveCodexReasoningEffort(asRecord(codex)?.reasoningEffort, defaults.codex.reasoningEffort),
      oauthPort: resolvePortNumber(asRecord(codex)?.oauthPort, defaults.codex.oauthPort)
    },
    ocr: {
      device: resolveOcrDevice(resolvedOcr?.device, defaults.ocr.device),
      gpuBackend: resolveOcrGpuBackend(resolvedOcr?.gpuBackend, defaults.ocr.gpuBackend ?? "cuda"),
      gpuCudaTag: resolveStoredOcrGpuCudaTag(resolvedOcr, defaults)
    },
    ui: {
      inpaintingGuideHidden: resolveBoolean(ui?.inpaintingGuideHidden, defaults.ui?.inpaintingGuideHidden ?? false)
    },
    inpainting: {
      fluxBackend: resolveFluxBackend(inpainting?.fluxBackend, defaults.inpainting?.fluxBackend ?? "cuda-native")
    },
    maxTokens: resolveMaxTokens(record?.maxTokens, defaults.maxTokens)
  };
}

export function parseStoredAppSettings(rawText: string | null | undefined, defaults = resolveDefaultAppSettings()): AppSettings {
  if (!rawText?.trim()) {
    return defaults;
  }

  return normalizeAppSettings(JSON.parse(rawText), defaults);
}

export function buildBaseTranslationOptions({
  jobId,
  runDir,
  paths,
  settings,
  env = process.env
}: {
  jobId: string;
  runDir: string;
  paths: TranslationOptionPaths;
  settings: AppSettings;
  env?: NodeJS.ProcessEnv;
}): TranslationOptions {
  const runtimeEnv = filterPackagedRuntimeEnv(env, paths);
  const gemmaVramMode = resolveGemmaVramMode(runtimeEnv.MANGA_TRANSLATOR_GEMMA_VRAM_MODE, settings.gemma.vramMode);
  const gemmaRuntimePreset = GEMMA_RUNTIME_PRESETS[gemmaVramMode];
  const runtimeGemma = resolveRuntimeGemmaSettings(settings.gemma, gemmaVramMode);
  const ocrGpuCudaTag = resolveOcrGpuCudaTag(
    runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG ??
      runtimeEnv.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG ??
      runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_CUDA,
    settings.ocr.gpuCudaTag ?? DEFAULT_OCR_GPU_CUDA_TAG
  );
  const ocrGpuBackend = resolveOcrGpuBackend(
    runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_BACKEND,
    settings.ocr.gpuBackend ?? "cuda"
  );
  const llamaRuntimeProfile = resolveLlamaRuntimeProfile(runtimeEnv, settings.gemma.llamaRuntimeProfile);
  const llamaRocmTarget =
    normalizeAmdRocmTarget(runtimeEnv.MANGA_TRANSLATOR_AMD_ROCM_TARGET ?? runtimeEnv.MANGA_TRANSLATOR_AMD_GFX_ARCH) ??
    normalizeAmdRocmTarget(settings.gemma.llamaRocmTarget);
  return {
    imagePath: "",
    outputDir: runDir,
    modelProvider: settings.modelProvider,
    port: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_LLAMA_PORT", 18180, { min: 1, max: 65535, integer: true }),
    promptMode: "ko_bbox_lines_multiview",
    temperature: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_TEMPERATURE", 0.2, { min: 0, max: 2 }),
    topP: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_TOP_P", 0.95, { min: 0.01, max: 1 }),
    topK: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_TOP_K", 64, { min: 1, max: 500, integer: true }),
    maxTokens: resolveMaxTokens(runtimeEnv.MANGA_TRANSLATOR_MAX_TOKENS, settings.maxTokens),
    ctx: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_CTX", gemmaRuntimePreset.ctx, { min: 1024, max: 32768, integer: true }),
    batch: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_BATCH", gemmaRuntimePreset.batch, { min: 1, max: 4096, integer: true }),
    ubatch: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_UBATCH", gemmaRuntimePreset.ubatch, { min: 1, max: 4096, integer: true }),
    gemmaVramMode,
    fitTargetMb: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_FIT_TARGET_MB", gemmaRuntimePreset.fitTargetMb, { min: 0, max: 8192, integer: true }),
    gpuLayers:
      readOptionalGpuLayersEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_GPU_LAYERS") ??
      readOptionalGpuLayersEnv(runtimeEnv, "MANGA_TRANSLATOR_GPU_LAYERS") ??
      gemmaRuntimePreset.gpuLayers,
    cacheTypeK:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_GEMMA_CACHE_TYPE_K ?? runtimeEnv.MANGA_TRANSLATOR_CACHE_TYPE_K) ??
      gemmaRuntimePreset.cacheTypeK,
    cacheTypeV:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_GEMMA_CACHE_TYPE_V ?? runtimeEnv.MANGA_TRANSLATOR_CACHE_TYPE_V) ??
      gemmaRuntimePreset.cacheTypeV,
    ctxCheckpoints:
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_CTX_CHECKPOINTS", { min: 0, max: 64, integer: true }) ??
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_CTX_CHECKPOINTS", { min: 0, max: 64, integer: true }) ??
      gemmaRuntimePreset.ctxCheckpoints,
    kvOffload: readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_KV_OFFLOAD") ?? gemmaRuntimePreset.kvOffload,
    mmprojOffload:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_MMPROJ_OFFLOAD") ?? gemmaRuntimePreset.mmprojOffload,
    threads:
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_THREADS", { min: 1, max: 128, integer: true }) ??
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_THREADS", { min: 1, max: 128, integer: true }) ??
      gemmaRuntimePreset.threads,
    threadsBatch:
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_THREADS_BATCH", { min: 1, max: 128, integer: true }) ??
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_THREADS_BATCH", { min: 1, max: 128, integer: true }) ??
      gemmaRuntimePreset.threadsBatch,
    poll:
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_POLL", { min: 0, max: 100, integer: true }) ??
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_POLL", { min: 0, max: 100, integer: true }) ??
      gemmaRuntimePreset.poll,
    pollBatch:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_POLL_BATCH") ??
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_POLL_BATCH") ??
      gemmaRuntimePreset.pollBatch,
    prioBatch:
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_PRIO_BATCH", { min: -1, max: 3, integer: true }) ??
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_PRIO_BATCH", { min: -1, max: 3, integer: true }) ??
      gemmaRuntimePreset.prioBatch,
    cacheIdleSlots:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_CACHE_IDLE_SLOTS") ??
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_CACHE_IDLE_SLOTS") ??
      gemmaRuntimePreset.cacheIdleSlots,
    cacheReuse:
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_CACHE_REUSE", { min: 0, max: 4096, integer: true }) ??
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_CACHE_REUSE", { min: 0, max: 4096, integer: true }) ??
      gemmaRuntimePreset.cacheReuse,
    enableMetrics:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_METRICS") ??
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_METRICS") ??
      gemmaRuntimePreset.enableMetrics,
    enablePerf:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_PERF") ??
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_PERF") ??
      gemmaRuntimePreset.enablePerf,
    draftModelRepo:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_DRAFT_MODEL_HF) ?? gemmaRuntimePreset.draftModelRepo,
    draftModelFile:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_DRAFT_MODEL_FILE) ?? gemmaRuntimePreset.draftModelFile,
    useDraft: readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_USE_DRAFT") ?? gemmaRuntimePreset.useDraft,
    imageMinTokens: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_IMAGE_MIN_TOKENS", DEFAULT_IMAGE_TOKENS, { min: 70, max: 2048, integer: true }),
    imageMaxTokens: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_IMAGE_MAX_TOKENS", DEFAULT_IMAGE_TOKENS, { min: 70, max: 2048, integer: true }),
    includeEnhancedVariant: false,
    enhancedMaxLongSide: 1900,
    enhancedContrast: 1.35,
    imageFirst: true,
    reuseServer: true,
    llamaRuntimeProfile,
    ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
    workingDir: paths.dataRoot,
    toolsDir: paths.toolsDir,
    serverPath:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_LLAMA_SERVER_PATH) ??
      resolveOptionalString(runtimeEnv.LLAMA_SERVER_PATH) ??
      resolveDefaultLlamaServerPathForGemma(paths, runtimeGemma, llamaRuntimeProfile, llamaRocmTarget ?? undefined),
    modelSource: runtimeGemma.modelSource,
    modelRepo: resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_MODEL_HF) ?? runtimeGemma.modelRepo,
    modelFile: resolveOptionalString(runtimeEnv.LLAMA_ARG_HF_FILE) ?? runtimeGemma.modelFile,
    mmprojRepo:
      runtimeGemma.modelSource === "huggingface"
        ? resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_MMPROJ_HF) ??
          runtimeGemma.mmprojRepo ??
          getDefaultMmprojForGemmaModel(runtimeGemma)?.mmprojRepo
        : undefined,
    mmprojFile:
      runtimeGemma.modelSource === "huggingface"
        ? resolveOptionalString(runtimeEnv.LLAMA_ARG_MMPROJ_FILE) ??
          runtimeGemma.mmprojFile ??
          getDefaultMmprojForGemmaModel(runtimeGemma)?.mmprojFile
        : undefined,
    localModelPath: runtimeGemma.localModelPath,
    localMmprojPath: runtimeGemma.localMmprojPath,
    codexModel: settings.codex.model,
    codexReasoningEffort: resolveCodexReasoningEffort(runtimeEnv.MANGA_TRANSLATOR_CODEX_REASONING_EFFORT, settings.codex.reasoningEffort),
    codexOauthPort: settings.codex.oauthPort,
    ocrDevice: resolveOcrDevice(runtimeEnv.MANGA_TRANSLATOR_OCR_DEVICE, settings.ocr.device),
    ocrGpuBackend,
    ocrGpuCudaTag,
    ocrBboxProvider: resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_OCR_BBOX_PROVIDER),
    ocrBboxCommand: resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_OCR_BBOX_CMD),
    ocrBboxHintsPath: resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH),
    ocrRuntimeDir: paths.ocrRuntimeDir,
    hfHomeDir: paths.hfHomeDir,
    hfHubCacheDir: paths.hfHubCacheDir,
    llamaCacheDir: paths.llamaCacheDir,
    label: `app-${jobId}`
  };
}

export function filterPackagedRuntimeEnv(
  env: NodeJS.ProcessEnv,
  paths: Pick<TranslationOptionPaths, "isPackaged">
): NodeJS.ProcessEnv {
  if (!paths.isPackaged || readBooleanLikeEnv(env.MGT_ALLOW_EXTERNAL_RUNTIME ?? env.MANGA_TRANSLATOR_ALLOW_EXTERNAL_RUNTIME)) {
    return env;
  }
  return {};
}

function readOptionalGpuLayersEnv(env: NodeJS.ProcessEnv, name: string): number | "fit" | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "fit") {
    return "fit";
  }
  if (normalized === "all") {
    return undefined;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value) : undefined;
}

function resolveModelProvider(value: unknown, fallback: ModelProvider): ModelProvider {
  return value === "openai-codex" || value === "gemma" ? value : fallback;
}

function resolveModelSource(value: unknown, fallback: ModelSource): ModelSource {
  return value === "local" || value === "huggingface" ? value : fallback;
}

function resolveGemmaVramMode(value: unknown, fallback: GemmaVramMode): GemmaVramMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["minimum12b", "minimum", "minimal", "min", "12b"].includes(normalized)) {
    return "minimum12b";
  }
  if (["economy26b", "economy", "eco", "26b"].includes(normalized)) {
    return "economy26b";
  }
  if (["full31b", "full", "31b"].includes(normalized)) {
    return "full31b";
  }
  return fallback;
}

function resolveOcrDevice(value: unknown, fallback: OcrDevice): OcrDevice {
  return value === "gpu" || value === "cpu" ? value : fallback;
}

function resolveOcrGpuBackend(value: unknown, fallback: OcrGpuBackend = "cuda"): OcrGpuBackend {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "rocm" || normalized === "hip" || normalized === "amd") {
    return "rocm";
  }
  if (normalized === "cuda" || normalized === "nvidia") {
    return "cuda";
  }
  return fallback;
}

function resolveFluxBackend(value: unknown, fallback: FluxBackend = "cuda-native"): FluxBackend {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["cuda-native", "cuda", "native", "nvidia"].includes(normalized)) {
    return "cuda-native";
  }
  if (["python-rocm", "rocm", "hip", "amd"].includes(normalized)) {
    return "python-rocm";
  }
  if (["python-cpu", "cpu"].includes(normalized)) {
    return "python-cpu";
  }
  return fallback;
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveOcrGpuCudaTag(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (/^cu\d+$/.test(text)) {
    return text;
  }
  const digits = text.replace(/\D/g, "");
  if (digits) {
    return `cu${digits}`;
  }
  return fallback;
}

function resolveStoredOcrGpuCudaTag(ocr: Record<string, unknown> | null, defaults: AppSettings): string {
  const defaultTag = defaults.ocr.gpuCudaTag ?? DEFAULT_OCR_GPU_CUDA_TAG;
  const stored = resolveOcrGpuCudaTag(ocr?.gpuCudaTag, defaultTag);
  if (defaultTag === RTX_50_OCR_GPU_CUDA_TAG && (!ocr?.gpuCudaTag || stored === DEFAULT_OCR_GPU_CUDA_TAG)) {
    return RTX_50_OCR_GPU_CUDA_TAG;
  }
  return stored;
}

function resolveHardwareOcrGpuCudaTag(info: DetectedGpuInfo | null): string {
  if (info?.vendor === "amd") {
    return DEFAULT_OCR_GPU_CUDA_TAG;
  }
  if ((info?.computeCapability ?? 0) >= 12 || (info?.rtxGeneration ?? 0) >= 50) {
    return RTX_50_OCR_GPU_CUDA_TAG;
  }
  return DEFAULT_OCR_GPU_CUDA_TAG;
}

function resolveHardwareOcrGpuBackend(info: DetectedGpuInfo | null): OcrGpuBackend {
  return info?.vendor === "amd" ? "rocm" : "cuda";
}

function resolveHardwareLlamaRocmTarget(info: DetectedGpuInfo | null): AmdRocmTarget | undefined {
  if (info?.vendor !== "amd") {
    return undefined;
  }
  return resolveAmdRocmTargetFromInfo(info) ?? undefined;
}

function resolveHardwareFluxBackend(info: DetectedGpuInfo | null): FluxBackend {
  if (info?.vendor !== "amd") {
    return "cuda-native";
  }
  return "python-cpu";
}

function resolveCodexReasoningEffort(value: unknown, fallback: CodexReasoningEffort): CodexReasoningEffort {
  if (value === "minimal") {
    return "low";
  }
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : fallback;
}

function resolveNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function resolveOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolvePortNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return clampInteger(parsed, 1, 65535);
}

function resolveMaxTokens(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return clampInteger(parsed, MIN_MAX_TOKENS, MAX_MAX_TOKENS);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function normalizeDetectedGpuInfo(value?: number | DetectedGpuInfo | null): DetectedGpuInfo | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0
      ? {
          name: null,
          memoryMb: value,
          rtxGeneration: null,
          computeCapability: null,
          vendor: "unknown"
        }
      : null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const memoryMb = typeof value.memoryMb === "number" && Number.isFinite(value.memoryMb) ? value.memoryMb : null;
  const rtxGeneration =
    typeof value.rtxGeneration === "number" && Number.isFinite(value.rtxGeneration) ? value.rtxGeneration : null;
  const computeCapability =
    typeof value.computeCapability === "number" && Number.isFinite(value.computeCapability) ? value.computeCapability : null;
  return {
    name: typeof value.name === "string" ? value.name : null,
    memoryMb,
    rtxGeneration,
    computeCapability,
    vendor: value.vendor === "nvidia" || value.vendor === "amd" ? value.vendor : "unknown",
    rocmArch: typeof value.rocmArch === "string" ? value.rocmArch : null,
    rocmTarget: normalizeAmdRocmTarget(value.rocmTarget),
    supportsRocm: typeof value.supportsRocm === "boolean" ? value.supportsRocm : false,
    supportsVulkan: typeof value.supportsVulkan === "boolean" ? value.supportsVulkan : false
  };
}

type GemmaModelPreset = Pick<AppSettings["gemma"], "modelRepo" | "modelFile" | "mmprojRepo" | "mmprojFile">;

function getDefaultGemmaPresetForVramMode(vramMode: GemmaVramMode): GemmaModelPreset {
  if (vramMode === "minimum12b") {
    return {
      modelRepo: GEMMA_12B_MODEL_REPO,
      modelFile: GEMMA_12B_MODEL_FILE_Q4_K_M,
      mmprojRepo: GEMMA_12B_MMPROJ_REPO,
      mmprojFile: GEMMA_12B_MMPROJ_FILE
    };
  }
  if (vramMode === "economy26b") {
    return {
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
      mmprojRepo: GEMMA_26B_MMPROJ_REPO,
      mmprojFile: GEMMA_26B_MMPROJ_FILE
    };
  }
  return {
    modelRepo: GEMMA_31B_MODEL_REPO,
    modelFile: GEMMA_31B_MODEL_FILE_IQ3_S,
    mmprojRepo: GEMMA_31B_MMPROJ_REPO,
    mmprojFile: GEMMA_31B_MMPROJ_FILE
  };
}

function getModeAwareGemmaDefaults(defaults: AppSettings, vramMode: GemmaVramMode): GemmaModelPreset {
  const currentDefaultModel = {
    modelRepo: defaults.gemma.modelRepo,
    modelFile: defaults.gemma.modelFile
  };
  if (!isBuiltInGemmaModel(currentDefaultModel)) {
    return {
      modelRepo: defaults.gemma.modelRepo,
      modelFile: defaults.gemma.modelFile,
      mmprojRepo: defaults.gemma.mmprojRepo,
      mmprojFile: defaults.gemma.mmprojFile
    };
  }
  return getDefaultGemmaPresetForVramMode(vramMode);
}

function resolveRuntimeGemmaSettings(
  gemma: AppSettings["gemma"],
  vramMode: GemmaVramMode
): AppSettings["gemma"] {
  if (gemma.modelSource !== "huggingface") {
    return gemma;
  }

  const model = { modelRepo: gemma.modelRepo, modelFile: gemma.modelFile };
  if (!isBuiltInGemmaModel(model)) {
    return gemma;
  }

  return {
    ...gemma,
    ...getDefaultGemmaPresetForVramMode(vramMode)
  };
}

function resolveDefaultLlamaServerPathForGemma(
  paths: TranslationOptionPaths,
  gemma: AppSettings["gemma"],
  llamaRuntimeProfile = "cuda12",
  llamaRocmTarget?: string
): string {
  if (gemma.modelSource !== "huggingface" || !isBuiltInGemmaModel({ modelRepo: gemma.modelRepo, modelFile: gemma.modelFile })) {
    return paths.llamaServerPath;
  }
  const binaryName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const useCuda13 = isRtx50LlamaRuntimeProfile(llamaRuntimeProfile);
  if (isRocmLlamaRuntimeProfile(llamaRuntimeProfile)) {
    const rocmTarget = normalizeAmdRocmTarget(llamaRocmTarget) ?? "unknown";
    return join(paths.dataRoot, "tools", `lemonade-llama-${LEMONADE_LLAMA_RUNTIME_ROCM_RELEASE}-rocm-${rocmTarget}`, binaryName);
  }
  if (isVulkanLlamaRuntimeProfile(llamaRuntimeProfile)) {
    return join(paths.dataRoot, "tools", MAINLINE_LLAMA_RUNTIME_DIR_VULKAN, binaryName);
  }
  const runtimeDir = isMainlineGemmaModel({ modelRepo: gemma.modelRepo, modelFile: gemma.modelFile })
    ? useCuda13 ? MAINLINE_LLAMA_RUNTIME_DIR_CUDA13 : MAINLINE_LLAMA_RUNTIME_DIR_CUDA12
    : useCuda13 ? BEELLAMA_LLAMA_RUNTIME_DIR_CUDA13 : BEELLAMA_LLAMA_RUNTIME_DIR_CUDA12;
  return join(paths.dataRoot, "tools", runtimeDir, binaryName);
}

function isBuiltInGemmaModel(model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">): boolean {
  return is12BGemmaModel(model) || is26BGemmaModel(model) || is31BGemmaModel(model);
}

function isMainlineGemmaModel(model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">): boolean {
  return is12BGemmaModel(model) || is26BGemmaModel(model);
}

function is12BGemmaModel(model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">): boolean {
  return model.modelRepo === GEMMA_12B_MODEL_REPO && model.modelFile === GEMMA_12B_MODEL_FILE_Q4_K_M;
}

function is31BGemmaModel(model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">): boolean {
  return model.modelRepo === GEMMA_31B_MODEL_REPO && model.modelFile === GEMMA_31B_MODEL_FILE_IQ3_S;
}

function is26BGemmaModel(model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">): boolean {
  return model.modelRepo === GEMMA_26B_MODEL_REPO && model.modelFile === GEMMA_26B_MODEL_FILE_IQ3_S;
}

function getDefaultMmprojForGemmaModel(
  model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">
): Pick<AppSettings["gemma"], "mmprojRepo" | "mmprojFile"> | undefined {
  if (is12BGemmaModel(model)) {
    return {
      mmprojRepo: GEMMA_12B_MMPROJ_REPO,
      mmprojFile: GEMMA_12B_MMPROJ_FILE
    };
  }
  if (is26BGemmaModel(model)) {
    return {
      mmprojRepo: GEMMA_26B_MMPROJ_REPO,
      mmprojFile: GEMMA_26B_MMPROJ_FILE
    };
  }
  if (is31BGemmaModel(model)) {
    return {
      mmprojRepo: GEMMA_31B_MMPROJ_REPO,
      mmprojFile: GEMMA_31B_MMPROJ_FILE
    };
  }
  return undefined;
}

function isBuiltInGemmaMmproj(mmprojRepo?: string, mmprojFile?: string): boolean {
  return (
    (mmprojRepo === GEMMA_31B_MMPROJ_REPO && mmprojFile === GEMMA_31B_MMPROJ_FILE) ||
    (mmprojRepo === GEMMA_26B_MMPROJ_REPO && mmprojFile === GEMMA_26B_MMPROJ_FILE) ||
    (mmprojRepo === GEMMA_12B_MMPROJ_REPO && mmprojFile === GEMMA_12B_MMPROJ_FILE)
  );
}

const LEGACY_GEMMA_MODEL_REPO = "unsloth/gemma-4-26B-A4B-it-GGUF";
const LEGACY_GEMMA_MODEL_FILES = new Set([
  "gemma-4-26B-A4B-it-UD-Q3_K_XL.gguf",
  "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf",
  "gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf"
]);

function resolveStoredGemmaModel(
  gemma: Record<string, unknown> | null,
  defaults: AppSettings,
  vramMode: GemmaVramMode = defaults.gemma.vramMode
): Pick<AppSettings["gemma"], "modelRepo" | "modelFile"> {
  const modelRepo = resolveNonEmptyString(gemma?.modelRepo, defaults.gemma.modelRepo);
  const modelFile = resolveNonEmptyString(gemma?.modelFile, defaults.gemma.modelFile);
  if (modelRepo === LEGACY_GEMMA_MODEL_REPO && LEGACY_GEMMA_MODEL_FILES.has(modelFile)) {
    return {
      modelRepo: defaults.gemma.modelRepo,
      modelFile: defaults.gemma.modelFile
    };
  }
  const resolvedModel = { modelRepo, modelFile };
  if (isBuiltInGemmaModel(resolvedModel)) {
    const preset = getDefaultGemmaPresetForVramMode(vramMode);
    return {
      modelRepo: preset.modelRepo,
      modelFile: preset.modelFile
    };
  }
  return resolvedModel;
}

function resolveStoredGemmaMmproj(
  gemma: Record<string, unknown> | null,
  model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">,
  defaults: AppSettings
): Pick<AppSettings["gemma"], "mmprojRepo" | "mmprojFile"> {
  const storedMmprojRepo = resolveOptionalString(gemma?.mmprojRepo);
  const storedMmprojFile = resolveOptionalString(gemma?.mmprojFile);
  const builtInMmproj = getDefaultMmprojForGemmaModel(model);
  if (
    builtInMmproj &&
    (!storedMmprojRepo || !storedMmprojFile || isBuiltInGemmaMmproj(storedMmprojRepo, storedMmprojFile))
  ) {
    return builtInMmproj;
  }
  if (storedMmprojRepo || storedMmprojFile) {
    return {
      mmprojRepo: storedMmprojRepo ?? defaults.gemma.mmprojRepo ?? builtInMmproj?.mmprojRepo ?? DEFAULT_GEMMA_MMPROJ_REPO,
      mmprojFile: storedMmprojFile ?? defaults.gemma.mmprojFile ?? builtInMmproj?.mmprojFile ?? DEFAULT_GEMMA_MMPROJ_FILE
    };
  }
  if (builtInMmproj) {
    return builtInMmproj;
  }
  return {};
}
