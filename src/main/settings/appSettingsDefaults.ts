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
  DEFAULT_MODEL_SOURCE,
  resolveRecommendedGenerationLimits,
} from "../../shared/modelPresets";
import type { AppSettings } from "../../shared/settingsTypes";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../../shared/blockFormat";
import {
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
  normalizeLanguageCode,
} from "../../shared/translationLanguages";
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
  resolvePortNumber,
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

export { resolveHardwareDefaults } from "./hardwareDefaults";

export function resolveDefaultAppSettings(
  env: NodeJS.ProcessEnv = process.env,
  detectedGpu?: number | DetectedGpuInfo | null,
): AppSettings {
  const hardwareDefaults = resolveHardwareDefaults(detectedGpu);
  const modelProvider = resolveModelProvider(
    env.MANGA_TRANSLATOR_MODEL_PROVIDER,
    hardwareDefaults.modelProvider,
  );
  const gemma = resolveDefaultGemmaSettings(env, hardwareDefaults);
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
    translation: resolveDefaultTranslationLanguageSettings(env),
    gemma,
    codex,
    api,
    ocr: resolveDefaultOcrSettings(env, hardwareDefaults),
    ui: resolveDefaultUiSettings(env),
    inpainting: resolveDefaultInpaintingSettings(env, hardwareDefaults),
    blockFormatDefaults: { ...DEFAULT_BLOCK_FORMAT_DEFAULTS },
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
    llamaRuntimeProfile,
    ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
  };
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
    oauthPort: resolvePortNumber(
      env.MANGA_TRANSLATOR_CODEX_OAUTH_PORT,
      DEFAULT_CODEX_OAUTH_PORT,
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
    analysisScopeDefault: "missing",
  };
}

function resolveDefaultInpaintingSettings(
  env: NodeJS.ProcessEnv,
  hardwareDefaults: HardwareDefaults,
): NonNullable<AppSettings["inpainting"]> {
  return {
    model: resolveInpaintingModel(
      env.MANGA_TRANSLATOR_INPAINTING_MODEL ?? env.MGT_INPAINTING_MODEL,
      "flux-klein",
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
  };
}
