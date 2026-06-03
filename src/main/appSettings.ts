import type {
  AppSettings,
  CodexReasoningEffort,
  GemmaVramMode,
  JobPhase,
  ModelProvider,
  ModelSource,
  OcrDevice
} from "../shared/types";
import type { DetectedGpuInfo } from "./gpuInfo";

export const GEMMA_31B_MODEL_REPO =
  "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-i1-GGUF";
export const GEMMA_31B_MODEL_FILE_IQ3_S =
  "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.i1-IQ3_S.gguf";
export const GEMMA_31B_MMPROJ_REPO =
  "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-GGUF";
export const GEMMA_31B_MMPROJ_FILE =
  "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.mmproj-f16.gguf";
export const GEMMA_26B_MODEL_REPO = "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-i1-GGUF";
export const GEMMA_26B_MODEL_FILE_IQ3_S = "gemma-4-26B-A4B-it-ultra-uncensored-heretic.i1-IQ3_S.gguf";
export const GEMMA_26B_MMPROJ_REPO = "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF";
export const GEMMA_26B_MMPROJ_FILE = "gemma-4-26B-A4B-it-ultra-uncensored-heretic.mmproj-Q8_0.gguf";
export const DEFAULT_GEMMA_MODEL_REPO = GEMMA_31B_MODEL_REPO;
export const DEFAULT_GEMMA_MODEL_FILE_IQ3_S = GEMMA_31B_MODEL_FILE_IQ3_S;
export const DEFAULT_GEMMA_MODEL_FILE = DEFAULT_GEMMA_MODEL_FILE_IQ3_S;
export const DEFAULT_GEMMA_MMPROJ_REPO = GEMMA_31B_MMPROJ_REPO;
export const DEFAULT_GEMMA_MMPROJ_FILE = GEMMA_31B_MMPROJ_FILE;
export const DEFAULT_GEMMA_DRAFT_MODEL_REPO = "Anbeeld/gemma-4-31B-it-DFlash-GGUF";
export const DEFAULT_GEMMA_DRAFT_MODEL_FILE = "gemma4-31b-it-dflash-IQ4_XS.gguf";
export const DEFAULT_GEMMA_VRAM_MODE: GemmaVramMode = "full";
export const DEFAULT_MODEL_PROVIDER: ModelProvider = "gemma";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = "low";
export const DEFAULT_CODEX_OAUTH_PORT = 10531;
export const DEFAULT_MODEL_SOURCE: ModelSource = "huggingface";
export const DEFAULT_MAX_TOKENS = 12000;
export const MIN_MAX_TOKENS = 300;
export const MAX_MAX_TOKENS = 12000;
export const DEFAULT_OCR_DEVICE: OcrDevice = "cpu";
export const DEFAULT_OCR_GPU_CUDA_TAG = "cu126";
export const RTX_50_OCR_GPU_CUDA_TAG = "cu129";

const DEFAULT_IMAGE_TOKENS = 1024;

type GemmaRuntimePreset = {
  ctx: number;
  batch: number;
  ubatch: number;
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
};

const GEMMA_RUNTIME_PRESETS: Record<GemmaVramMode, GemmaRuntimePreset> = {
  full: {
    ctx: 8192,
    batch: 1024,
    ubatch: 1024,
    fitTargetMb: 1024,
    cacheTypeK: "q4_0",
    cacheTypeV: "q4_0",
    ctxCheckpoints: 0,
    kvOffload: true,
    mmprojOffload: true,
    enableMetrics: true,
    enablePerf: true,
    draftModelRepo: DEFAULT_GEMMA_DRAFT_MODEL_REPO,
    draftModelFile: DEFAULT_GEMMA_DRAFT_MODEL_FILE,
    useDraft: true
  },
  economy: {
    ctx: 8192,
    batch: 1024,
    ubatch: 1024,
    fitTargetMb: 9000,
    cacheTypeK: "q4_0",
    cacheTypeV: "q4_0",
    ctxCheckpoints: 0,
    kvOffload: true,
    mmprojOffload: true,
    gpuLayers: "fit",
    enableMetrics: true,
    enablePerf: true,
    useDraft: false
  }
};

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
  ocrGpuCudaTag?: string;
  ocrBboxProvider?: string;
  ocrBboxCommand?: string;
  ocrBboxHintsPath?: string;
  ocrBboxHints?: unknown;
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
  label: string;
  abortSignal?: AbortSignal;
};

export type TranslationOptionPaths = {
  dataRoot: string;
  toolsDir: string;
  ocrRuntimeDir?: string;
  llamaServerPath: string;
  hfHomeDir?: string;
  hfHubCacheDir?: string;
};

export function resolveDefaultAppSettings(
  env: NodeJS.ProcessEnv = process.env,
  detectedGpu?: number | DetectedGpuInfo | null
): AppSettings {
  const hardwareDefaults = resolveHardwareDefaults(detectedGpu);
  const vramMode = resolveGemmaVramMode(env.MANGA_TRANSLATOR_GEMMA_VRAM_MODE, hardwareDefaults.gemmaVramMode);
  const defaultGemmaPreset = getDefaultGemmaPresetForVramMode(vramMode);
  return {
    modelProvider: resolveModelProvider(env.MANGA_TRANSLATOR_MODEL_PROVIDER, hardwareDefaults.modelProvider),
    gemma: {
      modelSource: DEFAULT_MODEL_SOURCE,
      modelRepo: resolveNonEmptyString(env.MANGA_TRANSLATOR_MODEL_HF, defaultGemmaPreset.modelRepo),
      modelFile: resolveNonEmptyString(env.LLAMA_ARG_HF_FILE, defaultGemmaPreset.modelFile),
      mmprojRepo: resolveOptionalString(env.MANGA_TRANSLATOR_MMPROJ_HF) ?? defaultGemmaPreset.mmprojRepo,
      mmprojFile: resolveOptionalString(env.LLAMA_ARG_MMPROJ_FILE) ?? defaultGemmaPreset.mmprojFile,
      vramMode
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
      gpuCudaTag: resolveOcrGpuCudaTag(
        env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG ??
          env.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG ??
          env.MANGA_TRANSLATOR_OCR_GPU_CUDA,
        hardwareDefaults.ocrGpuCudaTag
      )
    },
    maxTokens: resolveMaxTokens(env.MANGA_TRANSLATOR_MAX_TOKENS, DEFAULT_MAX_TOKENS)
  };
}

export function resolveHardwareDefaults(
  detectedGpu?: number | DetectedGpuInfo | null
): { modelProvider: ModelProvider; gemmaVramMode: GemmaVramMode; ocrDevice: OcrDevice; ocrGpuCudaTag: string } {
  const info = normalizeDetectedGpuInfo(detectedGpu);
  const supportedRtxGeneration = (info?.rtxGeneration ?? 0) >= 30;
  const supportedComputeCapability = (info?.computeCapability ?? 0) >= 8;
  if (!info || !info.memoryMb || (!supportedRtxGeneration && !supportedComputeCapability)) {
    return {
      modelProvider: "openai-codex",
      gemmaVramMode: "economy",
      ocrDevice: "cpu",
      ocrGpuCudaTag: resolveHardwareOcrGpuCudaTag(info)
    };
  }

  const ocrDevice: OcrDevice = info.memoryMb >= 12000 ? "gpu" : "cpu";
  const ocrGpuCudaTag = resolveHardwareOcrGpuCudaTag(info);
  if (info.memoryMb >= 24000) {
    return {
      modelProvider: "gemma",
      gemmaVramMode: "full",
      ocrDevice,
      ocrGpuCudaTag
    };
  }
  if (info.memoryMb >= 16000) {
    return {
      modelProvider: "gemma",
      gemmaVramMode: "economy",
      ocrDevice,
      ocrGpuCudaTag
    };
  }
  return {
    modelProvider: "openai-codex",
    gemmaVramMode: "economy",
    ocrDevice,
    ocrGpuCudaTag
  };
}

export function normalizeAppSettings(raw: unknown, defaults = resolveDefaultAppSettings()): AppSettings {
  const record = asRecord(raw);
  const gemma = record?.gemma;
  const codex = record?.codex;
  const ocr = record?.ocr;
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
      vramMode: resolvedVramMode
    },
    codex: {
      model: resolveNonEmptyString(asRecord(codex)?.model, defaults.codex.model),
      reasoningEffort: resolveCodexReasoningEffort(asRecord(codex)?.reasoningEffort, defaults.codex.reasoningEffort),
      oauthPort: resolvePortNumber(asRecord(codex)?.oauthPort, defaults.codex.oauthPort)
    },
    ocr: {
      device: resolveOcrDevice(resolvedOcr?.device, defaults.ocr.device),
      gpuCudaTag: resolveStoredOcrGpuCudaTag(resolvedOcr, defaults)
    },
    maxTokens: resolveMaxTokens(record?.maxTokens, defaults.maxTokens)
  };
}

export function parseStoredAppSettings(rawText: string | null | undefined, defaults = resolveDefaultAppSettings()): AppSettings {
  if (!rawText?.trim()) {
    return defaults;
  }

  try {
    return normalizeAppSettings(JSON.parse(rawText), defaults);
  } catch {
    return defaults;
  }
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
  const gemmaVramMode = resolveGemmaVramMode(env.MANGA_TRANSLATOR_GEMMA_VRAM_MODE, settings.gemma.vramMode);
  const gemmaRuntimePreset = GEMMA_RUNTIME_PRESETS[gemmaVramMode];
  const runtimeGemma = resolveRuntimeGemmaSettings(settings.gemma, gemmaVramMode);
  return {
    imagePath: "",
    outputDir: runDir,
    modelProvider: settings.modelProvider,
    port: readNumberEnv(env, "MANGA_TRANSLATOR_LLAMA_PORT", 18180),
    promptMode: "ko_bbox_lines_multiview",
    temperature: readNumberEnv(env, "MANGA_TRANSLATOR_TEMPERATURE", 0.2),
    topP: readNumberEnv(env, "MANGA_TRANSLATOR_TOP_P", 0.95),
    topK: readNumberEnv(env, "MANGA_TRANSLATOR_TOP_K", 64),
    maxTokens: resolveMaxTokens(env.MANGA_TRANSLATOR_MAX_TOKENS, settings.maxTokens),
    ctx: readNumberEnv(env, "MANGA_TRANSLATOR_CTX", gemmaRuntimePreset.ctx),
    batch: readNumberEnv(env, "MANGA_TRANSLATOR_BATCH", gemmaRuntimePreset.batch),
    ubatch: readNumberEnv(env, "MANGA_TRANSLATOR_UBATCH", gemmaRuntimePreset.ubatch),
    gemmaVramMode,
    fitTargetMb: readNumberEnv(env, "MANGA_TRANSLATOR_FIT_TARGET_MB", gemmaRuntimePreset.fitTargetMb),
    gpuLayers:
      readOptionalGpuLayersEnv(env, "MANGA_TRANSLATOR_GEMMA_GPU_LAYERS") ??
      readOptionalGpuLayersEnv(env, "MANGA_TRANSLATOR_GPU_LAYERS") ??
      gemmaRuntimePreset.gpuLayers,
    cacheTypeK:
      resolveOptionalString(env.MANGA_TRANSLATOR_GEMMA_CACHE_TYPE_K ?? env.MANGA_TRANSLATOR_CACHE_TYPE_K) ??
      gemmaRuntimePreset.cacheTypeK,
    cacheTypeV:
      resolveOptionalString(env.MANGA_TRANSLATOR_GEMMA_CACHE_TYPE_V ?? env.MANGA_TRANSLATOR_CACHE_TYPE_V) ??
      gemmaRuntimePreset.cacheTypeV,
    ctxCheckpoints:
      readOptionalNumberEnv(env, "MANGA_TRANSLATOR_GEMMA_CTX_CHECKPOINTS") ??
      readOptionalNumberEnv(env, "MANGA_TRANSLATOR_CTX_CHECKPOINTS") ??
      gemmaRuntimePreset.ctxCheckpoints,
    kvOffload: readOptionalBooleanEnv(env, "MANGA_TRANSLATOR_KV_OFFLOAD") ?? gemmaRuntimePreset.kvOffload,
    mmprojOffload:
      readOptionalBooleanEnv(env, "MANGA_TRANSLATOR_MMPROJ_OFFLOAD") ?? gemmaRuntimePreset.mmprojOffload,
    threads:
      readOptionalNumberEnv(env, "MANGA_TRANSLATOR_GEMMA_THREADS") ??
      readOptionalNumberEnv(env, "MANGA_TRANSLATOR_THREADS") ??
      gemmaRuntimePreset.threads,
    threadsBatch:
      readOptionalNumberEnv(env, "MANGA_TRANSLATOR_GEMMA_THREADS_BATCH") ??
      readOptionalNumberEnv(env, "MANGA_TRANSLATOR_THREADS_BATCH") ??
      gemmaRuntimePreset.threadsBatch,
    poll:
      readOptionalNumberEnv(env, "MANGA_TRANSLATOR_GEMMA_POLL") ??
      readOptionalNumberEnv(env, "MANGA_TRANSLATOR_POLL") ??
      gemmaRuntimePreset.poll,
    pollBatch:
      readOptionalBooleanEnv(env, "MANGA_TRANSLATOR_GEMMA_POLL_BATCH") ??
      readOptionalBooleanEnv(env, "MANGA_TRANSLATOR_POLL_BATCH") ??
      gemmaRuntimePreset.pollBatch,
    prioBatch:
      readOptionalNumberEnv(env, "MANGA_TRANSLATOR_GEMMA_PRIO_BATCH") ??
      readOptionalNumberEnv(env, "MANGA_TRANSLATOR_PRIO_BATCH") ??
      gemmaRuntimePreset.prioBatch,
    cacheIdleSlots:
      readOptionalBooleanEnv(env, "MANGA_TRANSLATOR_GEMMA_CACHE_IDLE_SLOTS") ??
      readOptionalBooleanEnv(env, "MANGA_TRANSLATOR_CACHE_IDLE_SLOTS") ??
      gemmaRuntimePreset.cacheIdleSlots,
    cacheReuse:
      readOptionalNumberEnv(env, "MANGA_TRANSLATOR_GEMMA_CACHE_REUSE") ??
      readOptionalNumberEnv(env, "MANGA_TRANSLATOR_CACHE_REUSE") ??
      gemmaRuntimePreset.cacheReuse,
    enableMetrics:
      readOptionalBooleanEnv(env, "MANGA_TRANSLATOR_GEMMA_METRICS") ??
      readOptionalBooleanEnv(env, "MANGA_TRANSLATOR_METRICS") ??
      gemmaRuntimePreset.enableMetrics,
    enablePerf:
      readOptionalBooleanEnv(env, "MANGA_TRANSLATOR_GEMMA_PERF") ??
      readOptionalBooleanEnv(env, "MANGA_TRANSLATOR_PERF") ??
      gemmaRuntimePreset.enablePerf,
    draftModelRepo:
      resolveOptionalString(env.MANGA_TRANSLATOR_DRAFT_MODEL_HF) ?? gemmaRuntimePreset.draftModelRepo,
    draftModelFile:
      resolveOptionalString(env.MANGA_TRANSLATOR_DRAFT_MODEL_FILE) ?? gemmaRuntimePreset.draftModelFile,
    useDraft: readOptionalBooleanEnv(env, "MANGA_TRANSLATOR_USE_DRAFT") ?? gemmaRuntimePreset.useDraft,
    imageMinTokens: readNumberEnv(env, "MANGA_TRANSLATOR_IMAGE_MIN_TOKENS", DEFAULT_IMAGE_TOKENS),
    imageMaxTokens: readNumberEnv(env, "MANGA_TRANSLATOR_IMAGE_MAX_TOKENS", DEFAULT_IMAGE_TOKENS),
    includeEnhancedVariant: false,
    enhancedMaxLongSide: 1900,
    enhancedContrast: 1.35,
    imageFirst: true,
    reuseServer: true,
    workingDir: paths.dataRoot,
    toolsDir: paths.toolsDir,
    serverPath:
      resolveOptionalString(env.MANGA_TRANSLATOR_LLAMA_SERVER_PATH) ??
      resolveOptionalString(env.LLAMA_SERVER_PATH) ??
      paths.llamaServerPath,
    modelSource: runtimeGemma.modelSource,
    modelRepo: resolveOptionalString(env.MANGA_TRANSLATOR_MODEL_HF) ?? runtimeGemma.modelRepo,
    modelFile: resolveOptionalString(env.LLAMA_ARG_HF_FILE) ?? runtimeGemma.modelFile,
    mmprojRepo:
      runtimeGemma.modelSource === "huggingface"
        ? resolveOptionalString(env.MANGA_TRANSLATOR_MMPROJ_HF) ??
          runtimeGemma.mmprojRepo ??
          getDefaultMmprojForGemmaModel(runtimeGemma)?.mmprojRepo
        : undefined,
    mmprojFile:
      runtimeGemma.modelSource === "huggingface"
        ? resolveOptionalString(env.LLAMA_ARG_MMPROJ_FILE) ??
          runtimeGemma.mmprojFile ??
          getDefaultMmprojForGemmaModel(runtimeGemma)?.mmprojFile
        : undefined,
    localModelPath: runtimeGemma.localModelPath,
    localMmprojPath: runtimeGemma.localMmprojPath,
    codexModel: settings.codex.model,
    codexReasoningEffort: resolveCodexReasoningEffort(env.MANGA_TRANSLATOR_CODEX_REASONING_EFFORT, settings.codex.reasoningEffort),
    codexOauthPort: settings.codex.oauthPort,
    ocrDevice: resolveOcrDevice(env.MANGA_TRANSLATOR_OCR_DEVICE, settings.ocr.device),
    ocrGpuCudaTag: resolveOcrGpuCudaTag(
      env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG ??
        env.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG ??
        env.MANGA_TRANSLATOR_OCR_GPU_CUDA,
      settings.ocr.gpuCudaTag ?? DEFAULT_OCR_GPU_CUDA_TAG
    ),
    ocrBboxProvider: resolveOptionalString(env.MANGA_TRANSLATOR_OCR_BBOX_PROVIDER),
    ocrBboxCommand: resolveOptionalString(env.MANGA_TRANSLATOR_OCR_BBOX_CMD),
    ocrBboxHintsPath: resolveOptionalString(env.MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH),
    ocrRuntimeDir: paths.ocrRuntimeDir,
    hfHomeDir: paths.hfHomeDir,
    hfHubCacheDir: paths.hfHubCacheDir,
    label: `app-${jobId}`
  };
}

function readNumberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function readOptionalNumberEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
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

function readOptionalBooleanEnv(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function resolveModelProvider(value: unknown, fallback: ModelProvider): ModelProvider {
  return value === "openai-codex" || value === "gemma" ? value : fallback;
}

function resolveModelSource(value: unknown, fallback: ModelSource): ModelSource {
  return value === "local" || value === "huggingface" ? value : fallback;
}

function resolveGemmaVramMode(value: unknown, fallback: GemmaVramMode): GemmaVramMode {
  return value === "economy" || value === "full" ? value : fallback;
}

function resolveOcrDevice(value: unknown, fallback: OcrDevice): OcrDevice {
  return value === "gpu" || value === "cpu" ? value : fallback;
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
  if ((info?.computeCapability ?? 0) >= 12 || (info?.rtxGeneration ?? 0) >= 50) {
    return RTX_50_OCR_GPU_CUDA_TAG;
  }
  return DEFAULT_OCR_GPU_CUDA_TAG;
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
  return clampInteger(parsed, 0, 65535);
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
          computeCapability: null
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
    computeCapability
  };
}

type GemmaModelPreset = Pick<AppSettings["gemma"], "modelRepo" | "modelFile" | "mmprojRepo" | "mmprojFile">;

function getDefaultGemmaPresetForVramMode(vramMode: GemmaVramMode): GemmaModelPreset {
  return vramMode === "economy"
    ? {
        modelRepo: GEMMA_26B_MODEL_REPO,
        modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
        mmprojRepo: GEMMA_26B_MMPROJ_REPO,
        mmprojFile: GEMMA_26B_MMPROJ_FILE
      }
    : {
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

function isBuiltInGemmaModel(model: Pick<AppSettings["gemma"], "modelRepo" | "modelFile">): boolean {
  return is31BGemmaModel(model) || is26BGemmaModel(model);
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
    (mmprojRepo === GEMMA_26B_MMPROJ_REPO && mmprojFile === GEMMA_26B_MMPROJ_FILE)
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
