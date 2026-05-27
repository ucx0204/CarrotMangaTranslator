import type { AppSettings, CodexReasoningEffort, JobPhase, ModelProvider, ModelSource, OcrDevice } from "../shared/types";

export const DEFAULT_GEMMA_MODEL_REPO = "unsloth/gemma-4-26B-A4B-it-GGUF";
export const DEFAULT_GEMMA_MODEL_FILE_Q3 = "gemma-4-26B-A4B-it-UD-Q3_K_XL.gguf";
export const DEFAULT_GEMMA_MODEL_FILE = "gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";
export const DEFAULT_GEMMA_MODEL_FILE_Q6 = "gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf";
export const MAX_GEMMA_GPU_LAYERS = 30;
export const DEFAULT_GEMMA_GPU_LAYERS = 30;
export const DEFAULT_MODEL_PROVIDER: ModelProvider = "gemma";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = "low";
export const DEFAULT_CODEX_OAUTH_PORT = 10531;
export const DEFAULT_MODEL_SOURCE: ModelSource = "huggingface";
export const DEFAULT_MAX_TOKENS = 12000;
export const MIN_MAX_TOKENS = 300;
export const MAX_MAX_TOKENS = 12000;
export const DEFAULT_OCR_DEVICE: OcrDevice = "cpu";

const DEFAULT_IMAGE_TOKENS = 640;

export type TranslationOptions = {
  imagePath: string;
  imageWidth?: number;
  imageHeight?: number;
  outputDir: string;
  modelProvider: ModelProvider;
  port: number;
  promptMode: string;
  promptOverrideText?: string;
  nsfwMode: boolean;
  temperature: number;
  topP: number;
  topK: number;
  maxTokens: number;
  ctx: number;
  batch: number;
  ubatch: number;
  gpuLayers: number;
  fitTargetMb: number;
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
  localModelPath?: string;
  localMmprojPath?: string;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  codexOauthPort: number;
  ocrDevice: OcrDevice;
  ocrBboxProvider?: string;
  ocrBboxCommand?: string;
  ocrBboxHintsPath?: string;
  ocrBboxHints?: unknown;
  onProgress?: (event: {
    phase: JobPhase;
    progressText: string;
    detail?: string;
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

export function resolveDefaultAppSettings(env: NodeJS.ProcessEnv = process.env, detectedGpuMemoryMb?: number | null): AppSettings {
  return {
    modelProvider: resolveModelProvider(env.MANGA_TRANSLATOR_MODEL_PROVIDER, DEFAULT_MODEL_PROVIDER),
    gemma: {
      modelSource: DEFAULT_MODEL_SOURCE,
      modelRepo: resolveNonEmptyString(env.MANGA_TRANSLATOR_MODEL_HF, DEFAULT_GEMMA_MODEL_REPO),
      modelFile: resolveNonEmptyString(env.LLAMA_ARG_HF_FILE, resolveRecommendedModelFile(detectedGpuMemoryMb)),
      gpuLayers: resolveGpuLayerCount(env.MANGA_TRANSLATOR_GPU_LAYERS, DEFAULT_GEMMA_GPU_LAYERS)
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
      device: resolveOcrDevice(env.MANGA_TRANSLATOR_OCR_DEVICE, DEFAULT_OCR_DEVICE)
    },
    nsfwMode: false,
    maxTokens: resolveMaxTokens(env.MANGA_TRANSLATOR_MAX_TOKENS, DEFAULT_MAX_TOKENS)
  };
}

export function normalizeAppSettings(raw: unknown, defaults = resolveDefaultAppSettings()): AppSettings {
  const record = asRecord(raw);
  const gemma = record?.gemma;
  const codex = record?.codex;
  const ocr = record?.ocr;
  const localModelPath = resolveOptionalString(asRecord(gemma)?.localModelPath);
  const localMmprojPath = resolveOptionalString(asRecord(gemma)?.localMmprojPath);
  return {
    modelProvider: resolveModelProvider(record?.modelProvider, defaults.modelProvider),
    gemma: {
      modelSource: resolveModelSource(asRecord(gemma)?.modelSource, defaults.gemma.modelSource),
      modelRepo: resolveNonEmptyString(asRecord(gemma)?.modelRepo, defaults.gemma.modelRepo),
      modelFile: resolveNonEmptyString(asRecord(gemma)?.modelFile, defaults.gemma.modelFile),
      ...(localModelPath ? { localModelPath } : {}),
      ...(localMmprojPath ? { localMmprojPath } : {}),
      gpuLayers: resolveGpuLayerCount(asRecord(gemma)?.gpuLayers, defaults.gemma.gpuLayers)
    },
    codex: {
      model: resolveNonEmptyString(asRecord(codex)?.model, defaults.codex.model),
      reasoningEffort: resolveCodexReasoningEffort(asRecord(codex)?.reasoningEffort, defaults.codex.reasoningEffort),
      oauthPort: resolvePortNumber(asRecord(codex)?.oauthPort, defaults.codex.oauthPort)
    },
    ocr: {
      device: resolveOcrDevice(asRecord(ocr)?.device, defaults.ocr.device)
    },
    nsfwMode: resolveBoolean(record?.nsfwMode, defaults.nsfwMode),
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
  return {
    imagePath: "",
    outputDir: runDir,
    modelProvider: settings.modelProvider,
    port: readNumberEnv(env, "MANGA_TRANSLATOR_LLAMA_PORT", 18180),
    promptMode: "ko_bbox_lines_multiview",
    nsfwMode: settings.nsfwMode,
    temperature: readNumberEnv(env, "MANGA_TRANSLATOR_TEMPERATURE", 0),
    topP: readNumberEnv(env, "MANGA_TRANSLATOR_TOP_P", 0.85),
    topK: readNumberEnv(env, "MANGA_TRANSLATOR_TOP_K", 40),
    maxTokens: resolveMaxTokens(env.MANGA_TRANSLATOR_MAX_TOKENS, settings.maxTokens),
    ctx: readNumberEnv(env, "MANGA_TRANSLATOR_CTX", 16384),
    batch: readNumberEnv(env, "MANGA_TRANSLATOR_BATCH", 32),
    ubatch: readNumberEnv(env, "MANGA_TRANSLATOR_UBATCH", 32),
    gpuLayers: settings.gemma.gpuLayers,
    fitTargetMb: readNumberEnv(env, "MANGA_TRANSLATOR_FIT_TARGET_MB", 4096),
    imageMinTokens: readNumberEnv(env, "MANGA_TRANSLATOR_IMAGE_MIN_TOKENS", DEFAULT_IMAGE_TOKENS),
    imageMaxTokens: readNumberEnv(env, "MANGA_TRANSLATOR_IMAGE_MAX_TOKENS", DEFAULT_IMAGE_TOKENS),
    includeEnhancedVariant: false,
    enhancedMaxLongSide: 1900,
    enhancedContrast: 1.35,
    imageFirst: true,
    reuseServer: true,
    workingDir: paths.dataRoot,
    toolsDir: paths.toolsDir,
    serverPath: paths.llamaServerPath,
    modelSource: settings.gemma.modelSource,
    modelRepo: settings.gemma.modelRepo,
    modelFile: settings.gemma.modelFile,
    localModelPath: settings.gemma.localModelPath,
    localMmprojPath: settings.gemma.localMmprojPath,
    codexModel: settings.codex.model,
    codexReasoningEffort: resolveCodexReasoningEffort(env.MANGA_TRANSLATOR_CODEX_REASONING_EFFORT, settings.codex.reasoningEffort),
    codexOauthPort: settings.codex.oauthPort,
    ocrDevice: resolveOcrDevice(env.MANGA_TRANSLATOR_OCR_DEVICE, settings.ocr.device),
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

function resolveModelProvider(value: unknown, fallback: ModelProvider): ModelProvider {
  return value === "openai-codex" || value === "gemma" ? value : fallback;
}

function resolveModelSource(value: unknown, fallback: ModelSource): ModelSource {
  return value === "local" || value === "huggingface" ? value : fallback;
}

function resolveOcrDevice(value: unknown, fallback: OcrDevice): OcrDevice {
  return value === "gpu" || value === "cpu" ? value : fallback;
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

function resolveGpuLayerCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return clampInteger(parsed, 0, MAX_GEMMA_GPU_LAYERS);
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

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function resolveRecommendedModelFile(gpuMemoryMb?: number | null): string {
  if (typeof gpuMemoryMb !== "number" || !Number.isFinite(gpuMemoryMb) || gpuMemoryMb <= 0) {
    return DEFAULT_GEMMA_MODEL_FILE;
  }

  if (gpuMemoryMb >= 32000) {
    return DEFAULT_GEMMA_MODEL_FILE_Q6;
  }

  if (gpuMemoryMb >= 24000) {
    return DEFAULT_GEMMA_MODEL_FILE;
  }

  return DEFAULT_GEMMA_MODEL_FILE_Q3;
}
