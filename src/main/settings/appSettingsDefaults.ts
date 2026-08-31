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
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_MODEL_SOURCE,
  resolveRecommendedGenerationLimits,
} from "../../shared/modelPresets";
import type { AppSettings } from "../../shared/settingsTypes";
import { DEFAULT_BUBBLE_LAYOUT_PADDING_RATIO } from "../../shared/bubbleLayoutSettings";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../../shared/blockFormat";
import { normalizeLanguageCode } from "../../shared/translationLanguages";
import {
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
} from "../../shared/translationLanguageDefaults";
import type { DetectedGpuInfo } from "../gpuInfo";
import { normalizeAmdRocmTarget } from "../gpuInfo";
import { getDefaultGemmaPresetForVramMode } from "./gemmaModelPresets";
import {
  resolveCodexReasoningEffort,
  resolveContextTokens,
  resolveFluxBackend,
  resolveGemmaVramMode,
  resolveInpaintingModel,
  resolveKoharuInpaintingBackend,
  resolveMaxTokens,
  resolveModelProvider,
  resolveNullableIntegerRange,
  resolveNullableNumberRange,
  resolveNullableReasoningEffort,
  resolveNonEmptyString,
  resolveNumberRange,
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOcrQualityMode,
  resolveOpenAiCompatibleBaseUrl,
  resolveOptionalString,
} from "./appSettingsResolvers";
import {
  resolveHardwareDefaults,
  type HardwareDefaults,
} from "./hardwareDefaults";
import { resolveLlamaRuntimeProfile } from "./llamaRuntimeProfile";
import { DEFAULT_UI_LOCALE, normalizeUiLocale } from "../../shared/uiLocales";
import {
  DEFAULT_API_KEY_MAX_ATTEMPTS,
  DEFAULT_API_RETRY_DELAY_SECONDS,
  MAX_API_KEY_MAX_ATTEMPTS,
  MAX_API_RETRY_DELAY_SECONDS,
  MIN_API_KEY_MAX_ATTEMPTS,
  MIN_API_RETRY_DELAY_SECONDS,
} from "../../shared/apiKeySettings";
import {
  normalizeComputeGpuIndex,
  normalizeGraphicsGpuPreference,
} from "../../shared/gpuSettings";
import { resolveDefaultInternetResearchSettings } from "./appSettingsInternetResearchNormalize";

export function resolveDefaultAppSettings(
  env: NodeJS.ProcessEnv = process.env,
  detectedGpu?: number | DetectedGpuInfo | null,
): AppSettings {
  const hardwareDefaults = resolveHardwareDefaults(detectedGpu);
  const modelProvider = resolveModelProvider(
    env.MANGA_TRANSLATOR_MODEL_PROVIDER,
    hardwareDefaults.modelProvider,
  );
  const gemma = resolveDefaultGemmaSettings(env, hardwareDefaults, detectedGpu);
  const codex = resolveDefaultCodexSettings(env);
  const api = resolveDefaultApiSettings(env);
  const recommendedLimits = resolveRecommendedGenerationLimits(
    modelProvider,
    modelProvider === "openai-codex"
      ? codex.model
      : modelProvider === "openai-api"
        ? api.model
        : null,
  );
  return {
    modelProvider,
    hardware: resolveDefaultHardwareGpuSettings(env),
    translation: resolveDefaultTranslationLanguageSettings(env),
    gemma,
    codex,
    internetResearch: resolveDefaultInternetResearchSettings(codex, api),
    api,
    ocr: resolveDefaultOcrSettings(env, hardwareDefaults),
    ui: resolveDefaultUiSettings(env),
    inpainting: resolveDefaultInpaintingSettings(env, hardwareDefaults),
    blockFormatDefaults: { ...DEFAULT_BLOCK_FORMAT_DEFAULTS },
    blockStylePresets: [],
    blockStylePresetGroups: [],
    keybindings: {},
    maxTokens: resolveMaxTokens(
      env.MANGA_TRANSLATOR_MAX_TOKENS,
      recommendedLimits.maxTokens,
    ),
    ctx: resolveContextTokens(
      env.MANGA_TRANSLATOR_CTX,
      recommendedLimits.contextTokens,
    ),
  };
}

function resolveDefaultHardwareGpuSettings(
  env: NodeJS.ProcessEnv,
): NonNullable<AppSettings["hardware"]> {
  const computeGpuIndex = normalizeComputeGpuIndex(
    env.MANGA_TRANSLATOR_COMPUTE_GPU_INDEX ?? env.MGT_COMPUTE_GPU_INDEX,
  );
  return {
    graphicsGpuPreference: normalizeGraphicsGpuPreference(
      env.MANGA_TRANSLATOR_GRAPHICS_GPU_PREFERENCE ??
        env.MGT_GRAPHICS_GPU_PREFERENCE,
    ),
    ...(computeGpuIndex === undefined ? {} : { computeGpuIndex }),
  };
}

function resolveDefaultTranslationLanguageSettings(
  env: NodeJS.ProcessEnv,
): NonNullable<AppSettings["translation"]> {
  return {
    sourceLanguage: normalizeLanguageCode(
      env.MANGA_TRANSLATOR_SOURCE_LANGUAGE,
      DEFAULT_SOURCE_LANGUAGE,
    ),
    targetLanguage: normalizeLanguageCode(
      env.MANGA_TRANSLATOR_TARGET_LANGUAGE,
      DEFAULT_TARGET_LANGUAGE,
    ),
  };
}

function resolveDefaultGemmaSettings(
  env: NodeJS.ProcessEnv,
  hardwareDefaults: HardwareDefaults,
  detectedGpu?: number | DetectedGpuInfo | null,
): AppSettings["gemma"] {
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
  const memoryDefaults = resolveDefaultGemmaVramSettings({
    detectedGpu,
    llamaRuntimeProfile,
    vramMode,
  });
  return {
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
    ...memoryDefaults,
    llamaRuntimeProfile,
    ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
    ...(resolveUnsafeUnifiedMemoryOverride(
      env.MANGA_TRANSLATOR_MAC_ALPHA_ALLOW_UNSAFE_UNIFIED_MEMORY ??
        env.MGT_MAC_ALPHA_ALLOW_UNSAFE_UNIFIED_MEMORY,
    )
      ? { allowUnsafeUnifiedMemory: true }
      : {}),
  };
}

// eslint-disable-next-line complexity -- GPU vendor, capacity, Metal unified memory, and model tier determine one conservative default tuple
function resolveDefaultGemmaVramSettings({
  detectedGpu,
  llamaRuntimeProfile,
  vramMode,
}: {
  detectedGpu?: number | DetectedGpuInfo | null;
  llamaRuntimeProfile: AppSettings["gemma"]["llamaRuntimeProfile"];
  vramMode: AppSettings["gemma"]["vramMode"];
}): Pick<AppSettings["gemma"], "fitTargetMb" | "mmprojOffload"> {
  const fitTargetMb =
    vramMode === "minimum12b" ? 512 : vramMode === "full31b" ? 1536 : 1024;
  const gpuMemoryMb =
    typeof detectedGpu === "number"
      ? detectedGpu
      : detectedGpu?.vendor === "apple"
        ? null
        : detectedGpu?.memoryMb;
  if (
    typeof gpuMemoryMb === "number" &&
    Number.isFinite(gpuMemoryMb) &&
    gpuMemoryMb > 0 &&
    gpuMemoryMb <= 8 * 1024
  ) {
    return { fitTargetMb, mmprojOffload: false };
  }
  // Preserve the existing conservative Metal headroom. Apple Silicon uses
  // unified memory, so the dedicated-VRAM 8 GiB rule does not apply to it.
  if (llamaRuntimeProfile === "metal" && vramMode !== "full31b") {
    return { fitTargetMb: 4096, mmprojOffload: true };
  }
  return { fitTargetMb, mmprojOffload: true };
}

function resolveUnsafeUnifiedMemoryOverride(value: unknown): boolean {
  return ["1", "true", "yes", "y", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function resolveDefaultCodexSettings(
  env: NodeJS.ProcessEnv,
): AppSettings["codex"] {
  return {
    model: resolveNonEmptyString(
      env.MANGA_TRANSLATOR_CODEX_MODEL,
      DEFAULT_CODEX_MODEL,
    ),
    reasoningEffort: resolveCodexReasoningEffort(
      env.MANGA_TRANSLATOR_CODEX_REASONING_EFFORT,
      DEFAULT_CODEX_REASONING_EFFORT,
    ),
  };
}

function resolveDefaultApiSettings(env: NodeJS.ProcessEnv): AppSettings["api"] {
  return {
    baseUrl: resolveOpenAiCompatibleBaseUrl(
      env.MANGA_TRANSLATOR_API_BASE_URL,
      DEFAULT_API_BASE_URL,
    ),
    model: resolveNonEmptyString(
      env.MANGA_TRANSLATOR_API_MODEL,
      DEFAULT_API_MODEL,
    ),
    keyMaxAttempts: Math.round(
      resolveNumberRange(
        env.MANGA_TRANSLATOR_API_KEY_MAX_ATTEMPTS,
        DEFAULT_API_KEY_MAX_ATTEMPTS,
        MIN_API_KEY_MAX_ATTEMPTS,
        MAX_API_KEY_MAX_ATTEMPTS,
      ),
    ),
    retryDelaySeconds: resolveNumberRange(
      env.MANGA_TRANSLATOR_API_RETRY_DELAY_SECONDS,
      DEFAULT_API_RETRY_DELAY_SECONDS,
      MIN_API_RETRY_DELAY_SECONDS,
      MAX_API_RETRY_DELAY_SECONDS,
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
  };
}

function resolveDefaultOcrSettings(
  env: NodeJS.ProcessEnv,
  hardwareDefaults: HardwareDefaults,
): AppSettings["ocr"] {
  return {
    device: resolveOcrDevice(
      env.MANGA_TRANSLATOR_OCR_DEVICE,
      hardwareDefaults.ocrDevice,
    ),
    qualityMode: resolveOcrQualityMode(
      env.MANGA_TRANSLATOR_OCR_QUALITY_MODE ??
        env.MANGA_TRANSLATOR_PADDLEOCR_QUALITY_MODE ??
        env.MANGA_TRANSLATOR_PADDLEOCR_PRESET,
      hardwareDefaults.ocrQualityMode,
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
  };
}

function resolveDefaultUiSettings(
  env: NodeJS.ProcessEnv,
): NonNullable<AppSettings["ui"]> {
  return {
    locale: normalizeUiLocale(
      env.MANGA_TRANSLATOR_UI_LOCALE,
      DEFAULT_UI_LOCALE,
    ),
    inpaintingGuideHidden: false,
    translationWorkflowDefault: "cumulative",
    cumulativeContextDetailDefault: "detailed",
    naturalTextLayoutDefault: true,
    autoFontMatchingDefault: false,
    fontSizeAutoFitDefault: true,
    eraseOriginalWorkflowDefault: false,
    bubbleLayoutWorkflowDefault: true,
  };
}

function resolveDefaultInpaintingSettings(
  env: NodeJS.ProcessEnv,
  hardwareDefaults: HardwareDefaults,
): NonNullable<AppSettings["inpainting"]> {
  const defaultModel =
    hardwareDefaults.fluxBackend === "cpu-native" ? "lama-manga" : "flux-klein";
  return {
    model: resolveInpaintingModel(
      env.MANGA_TRANSLATOR_INPAINTING_MODEL ?? env.MGT_INPAINTING_MODEL,
      defaultModel,
    ),
    fluxBackend: resolveFluxBackend(
      env.MANGA_TRANSLATOR_FLUX_BACKEND ?? env.MGT_FLUX_BACKEND,
      hardwareDefaults.fluxBackend,
    ),
    koharuBackend: resolveKoharuInpaintingBackend(
      env.MANGA_TRANSLATOR_KOHARU_INPAINT_BACKEND ??
        env.MGT_KOHARU_INPAINT_BACKEND,
      "auto",
    ),
    allowUnsafeLowMemoryFlux: false,
    bubbleLayoutAfterInpainting: false,
    bubbleLayoutPaddingRatio: DEFAULT_BUBBLE_LAYOUT_PADDING_RATIO,
  };
}
