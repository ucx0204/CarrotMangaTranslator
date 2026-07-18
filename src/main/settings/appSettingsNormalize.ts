import type { AppSettings, GemmaVramMode } from "../../shared/settingsTypes";
import {
  DEFAULT_TRANSLATION_LANGUAGE_SETTINGS,
  resolveTranslationLanguageSettings,
} from "../../shared/translationLanguages";
import {
  asRecord,
  inferHardwareVendorFromDefaults,
  resolveAnalysisScopeDefault,
  resolveBoolean,
  resolveCodexReasoningEffort,
  resolveContextTokens,
  resolveGemmaVramMode,
  resolveMaxTokens,
  resolveModelProvider,
  resolveModelSource,
  resolveNullableIntegerRange,
  resolveNullableNumberRange,
  resolveNullableReasoningEffort,
  resolveNonEmptyString,
  resolveNumberRange,
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrQualityMode,
  resolveOpenAiCompatibleBaseUrl,
  resolveOptionalJsonObjectString,
  resolveOptionalString,
  resolvePortNumber,
} from "./appSettingsResolvers";
import { resolveDefaultAppSettings } from "./appSettingsDefaults";
import {
  resolveStoredFluxBackend,
  resolveStoredGemmaMmproj,
  resolveStoredGemmaModel,
  resolveStoredInpaintingModel,
  resolveStoredKoharuInpaintingBackend,
  resolveStoredLlamaRocmTarget,
  resolveStoredLlamaRuntimeProfile,
  resolveStoredOcrGpuCudaTag,
} from "./appSettingsStoredResolvers";
import { getModeAwareGemmaDefaults } from "./gemmaModelPresets";
import { normalizeUiLocale } from "../../shared/uiLocales";
import {
  DEFAULT_API_KEY_MAX_ATTEMPTS,
  DEFAULT_API_RETRY_DELAY_SECONDS,
  MAX_API_KEY_MAX_ATTEMPTS,
  MAX_API_RETRY_DELAY_SECONDS,
  MIN_API_KEY_MAX_ATTEMPTS,
  MIN_API_RETRY_DELAY_SECONDS,
  normalizeApiKeysText,
} from "../../shared/apiKeySettings";
import { resolveRecommendedGenerationLimits } from "../../shared/modelPresets";
import { normalizeBlockFormatDefaults } from "./blockFormatDefaultsNormalize";
import { resolveUnsafeUnifiedMemorySetting } from "./gemmaMemorySettings";

export function normalizeAppSettings(
  raw: unknown,
  defaults = resolveDefaultAppSettings(),
): AppSettings {
  const record = asRecord(raw) ?? {};
  const modelProvider = resolveModelProvider(
    record.modelProvider,
    defaults.modelProvider,
  );
  const codex = normalizeCodexSettings(asRecord(record.codex), defaults);
  const api = normalizeApiSettings(asRecord(record.api), defaults);
  const limitFallbacks = resolveGenerationLimitFallbacks({
    api,
    codex,
    defaults,
    modelProvider,
  });
  return {
    modelProvider,
    // 언어쌍이 없거나 잘못된 기존 설정은 항상 일본어 -> 한국어로 정규화된다.
    translation: resolveTranslationLanguageSettings(
      record.translation,
      defaults.translation ?? DEFAULT_TRANSLATION_LANGUAGE_SETTINGS,
    ),
    gemma: normalizeGemmaSettings(asRecord(record.gemma), defaults),
    codex,
    api,
    ocr: normalizeOcrSettings(asRecord(record.ocr), defaults),
    ui: normalizeUiSettings(asRecord(record.ui), defaults),
    inpainting: normalizeInpaintingSettings(
      asRecord(record.inpainting),
      defaults,
    ),
    blockFormatDefaults: normalizeBlockFormatDefaults(
      asRecord(record.blockFormatDefaults),
      defaults,
    ),
    keybindings: normalizeKeybindings(record.keybindings, defaults),
    maxTokens: resolveMaxTokens(record.maxTokens, limitFallbacks.maxTokens),
    ctx: resolveContextTokens(record.ctx, limitFallbacks.contextTokens),
  };
}

function resolveGenerationLimitFallbacks({
  api,
  codex,
  defaults,
  modelProvider,
}: {
  api: AppSettings["api"];
  codex: AppSettings["codex"];
  defaults: AppSettings;
  modelProvider: AppSettings["modelProvider"];
}): { contextTokens: number; maxTokens: number } {
  const activeModel =
    modelProvider === "openai-codex"
      ? codex.model
      : modelProvider === "openai-api"
        ? api.model
        : null;
  const defaultActiveModel =
    defaults.modelProvider === "openai-codex"
      ? defaults.codex.model
      : defaults.modelProvider === "openai-api"
        ? defaults.api.model
        : null;
  if (
    modelProvider === defaults.modelProvider &&
    activeModel === defaultActiveModel
  ) {
    return {
      contextTokens: defaults.ctx,
      maxTokens: defaults.maxTokens,
    };
  }
  const recommended = resolveRecommendedGenerationLimits(
    modelProvider,
    activeModel,
  );
  return {
    contextTokens: recommended.contextTokens,
    maxTokens: recommended.maxTokens,
  };
}

function normalizeKeybindings(
  keybindings: unknown,
  defaults: AppSettings,
): NonNullable<AppSettings["keybindings"]> {
  const record = asRecord(keybindings);
  if (!record) {
    return { ...(defaults.keybindings ?? {}) };
  }
  const normalized: Record<string, string> = {};
  for (const [actionId, combo] of Object.entries(record)) {
    if (typeof actionId === "string" && typeof combo === "string") {
      normalized[actionId] = combo;
    }
  }
  return normalized;
}

function normalizeGemmaSettings(
  gemma: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["gemma"] {
  const modelSource = resolveModelSource(
    gemma?.modelSource,
    defaults.gemma.modelSource,
  );
  const resolvedVramMode = resolveGemmaVramMode(
    gemma?.vramMode,
    defaults.gemma.vramMode,
  );
  const modeDefaults = resolveModeAwareDefaults(defaults, resolvedVramMode);
  const resolvedModel = resolveStoredGemmaModel(
    gemma,
    modeDefaults,
    resolvedVramMode,
  );
  const resolvedMmproj =
    modelSource === "huggingface"
      ? resolveStoredGemmaMmproj(gemma, resolvedModel, modeDefaults)
      : {};
  const localModelPath = resolveOptionalString(gemma?.localModelPath);
  const localMmprojPath = resolveOptionalString(gemma?.localMmprojPath);
  const llamaRuntimeProfile = resolveStoredLlamaRuntimeProfile(gemma, defaults);
  const llamaRocmTarget = resolveStoredLlamaRocmTarget(
    gemma,
    defaults,
    llamaRuntimeProfile,
  );
  return {
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
    ...resolveUnsafeUnifiedMemorySetting(gemma, defaults),
  };
}

function resolveModeAwareDefaults(
  defaults: AppSettings,
  resolvedVramMode: GemmaVramMode,
): AppSettings {
  const modeAwareGemmaDefaults = getModeAwareGemmaDefaults(
    defaults,
    resolvedVramMode,
  );
  return {
    ...defaults,
    gemma: {
      ...defaults.gemma,
      ...modeAwareGemmaDefaults,
    },
  };
}

function normalizeCodexSettings(
  codex: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["codex"] {
  return {
    model: resolveNonEmptyString(codex?.model, defaults.codex.model),
    reasoningEffort: resolveCodexReasoningEffort(
      codex?.reasoningEffort,
      defaults.codex.reasoningEffort,
    ),
    oauthPort: resolvePortNumber(codex?.oauthPort, defaults.codex.oauthPort),
  };
}

function normalizeApiSettings(
  api: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["api"] {
  return {
    baseUrl: resolveOpenAiCompatibleBaseUrl(api?.baseUrl, defaults.api.baseUrl),
    model: resolveNonEmptyString(api?.model, defaults.api.model),
    ...resolveApiKeySettings(api),
    keyMaxAttempts: Math.round(
      resolveNumberRange(
        api?.keyMaxAttempts,
        defaults.api.keyMaxAttempts ?? DEFAULT_API_KEY_MAX_ATTEMPTS,
        MIN_API_KEY_MAX_ATTEMPTS,
        MAX_API_KEY_MAX_ATTEMPTS,
      ),
    ),
    retryDelaySeconds: resolveNumberRange(
      api?.retryDelaySeconds,
      defaults.api.retryDelaySeconds ?? DEFAULT_API_RETRY_DELAY_SECONDS,
      MIN_API_RETRY_DELAY_SECONDS,
      MAX_API_RETRY_DELAY_SECONDS,
    ),
    ...resolveApiSamplingSettings(api, defaults),
    ...resolveApiReasoningSettings(api, defaults),
    ...resolveApiJsonSettings(api, defaults),
  };
}

function resolveApiKeySettings(
  api: Record<string, unknown> | null,
): Pick<AppSettings["api"], "apiKey"> | Record<string, never> {
  const apiKey = normalizeApiKeysText(api?.apiKey);
  return apiKey ? { apiKey } : {};
}

function resolveApiSamplingSettings(
  api: Record<string, unknown> | null,
  defaults: AppSettings,
): Pick<AppSettings["api"], "temperature" | "topP" | "topK"> {
  return {
    temperature: resolveNullableNumberRange(
      api?.temperature,
      defaults.api.temperature ?? null,
      0,
      2,
    ),
    topP: resolveNullableNumberRange(
      api?.topP,
      defaults.api.topP ?? null,
      0,
      1,
    ),
    topK: resolveNullableIntegerRange(
      api?.topK,
      defaults.api.topK ?? null,
      1,
      1000,
    ),
  };
}

function resolveApiReasoningSettings(
  api: Record<string, unknown> | null,
  defaults: AppSettings,
): Pick<AppSettings["api"], "reasoningEffort"> {
  return {
    reasoningEffort: resolveNullableReasoningEffort(
      api?.reasoningEffort,
      defaults.api.reasoningEffort ?? null,
    ),
  };
}

function resolveApiJsonSettings(
  api: Record<string, unknown> | null,
  defaults: AppSettings,
): Pick<AppSettings["api"], "extraBodyJson" | "customHeadersJson"> {
  return {
    extraBodyJson: resolveOptionalJsonObjectString(
      api?.extraBodyJson,
      defaults.api.extraBodyJson ?? "",
    ),
    customHeadersJson: resolveOptionalJsonObjectString(
      api?.customHeadersJson,
      defaults.api.customHeadersJson ?? "",
    ),
  };
}

function normalizeOcrSettings(
  ocr: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["ocr"] {
  const hardwareVendor = inferHardwareVendorFromDefaults(defaults);
  // On AMD hardware the ROCm OCR backend is only trusted when the current
  // hardware defaults grant it (Windows-ROCm-supported GPU). A stored
  // "rocm-transformers" from an older app version is ignored otherwise, so
  // the device downgrade below kicks in.
  const gpuBackend =
    hardwareVendor === "amd" && defaults.ocr.gpuBackend !== "rocm-transformers"
      ? resolveOcrGpuBackend(defaults.ocr.gpuBackend, "cuda")
      : resolveOcrGpuBackend(
          ocr?.gpuBackend,
          defaults.ocr.gpuBackend ?? "cuda",
        );
  const device =
    hardwareVendor === "apple" ||
    (hardwareVendor === "amd" && gpuBackend !== "rocm-transformers")
      ? "cpu"
      : resolveOcrDevice(ocr?.device, defaults.ocr.device);
  const qualityMode = resolveOcrQualityMode(
    ocr?.qualityMode,
    defaults.ocr.qualityMode,
  );
  return {
    device,
    // 풀로드(PaddleOCR-VL) 품질은 CPU에서 못 쓸 만큼 느리므로 CPU 장치에서는
    // 절약 품질로 강제한다.
    qualityMode:
      device === "cpu" && qualityMode === "full" ? "economy" : qualityMode,
    gpuBackend,
    gpuCudaTag: resolveStoredOcrGpuCudaTag(ocr, defaults),
  };
}

function normalizeUiSettings(
  ui: Record<string, unknown> | null,
  defaults: AppSettings,
): NonNullable<AppSettings["ui"]> {
  const data = ui ?? {};
  const base = defaults.ui ?? {};
  const blockModeDefault =
    data.blockModeDefault === "auto" || data.blockModeDefault === "keep"
      ? data.blockModeDefault
      : base.blockModeDefault;
  const translationWorkflowDefault =
    data.translationWorkflowDefault === "standard" ||
    data.translationWorkflowDefault === "cumulative" ||
    data.translationWorkflowDefault === "two-pass"
      ? data.translationWorkflowDefault
      : (base.translationWorkflowDefault ?? "cumulative");
  return {
    locale: normalizeUiLocale(data.locale, base.locale),
    inpaintingGuideHidden: resolveBoolean(
      data.inpaintingGuideHidden,
      base.inpaintingGuideHidden ?? false,
    ),
    translationWorkflowDefault,
    analysisScopeDefault: resolveAnalysisScopeDefault(
      data.analysisScopeDefault,
      base.analysisScopeDefault ?? "missing",
    ),
    ...(blockModeDefault ? { blockModeDefault } : {}),
  };
}

function normalizeInpaintingSettings(
  inpainting: Record<string, unknown> | null,
  defaults: AppSettings,
): NonNullable<AppSettings["inpainting"]> {
  return {
    model: resolveStoredInpaintingModel(inpainting, defaults),
    fluxBackend: resolveStoredFluxBackend(inpainting, defaults),
    koharuBackend: resolveStoredKoharuInpaintingBackend(inpainting, defaults),
    allowUnsafeLowMemoryFlux: resolveBoolean(
      inpainting?.allowUnsafeLowMemoryFlux,
      defaults.inpainting?.allowUnsafeLowMemoryFlux ?? false,
    ),
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
