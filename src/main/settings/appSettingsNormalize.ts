import type { AppSettings } from "../../shared/settingsTypes";
import {
  DEFAULT_TRANSLATION_LANGUAGE_SETTINGS,
  resolveTranslationLanguageSettings,
} from "../../shared/translationLanguages";
import {
  asRecord,
  resolveBoolean,
  resolveContextTokens,
  resolveMaxTokens,
  resolveModelProvider,
  resolveNullableIntegerRange,
  resolveNullableNumberRange,
  resolveNullableReasoningEffort,
  resolveNonEmptyString,
  resolveNumberRange,
  resolveOpenAiCompatibleBaseUrl,
  resolveOptionalJsonObjectString,
} from "./appSettingsResolvers";
import { resolveDefaultAppSettings } from "./appSettingsDefaults";
import {
  resolveStoredFluxBackend,
  resolveStoredInpaintingModel,
  resolveStoredKoharuInpaintingBackend,
  resolveStoredOcrGpuCudaTag,
  resolveStoredOcrModeSettings,
} from "./appSettingsStoredResolvers";
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
import { normalizeUiSettings } from "./appSettingsUiNormalize";
import { normalizeGemmaSettings } from "./gemmaMemorySettings";
import { normalizeStoredKeybindingOverrides } from "../../shared/shortcutSettings";
import {
  DEFAULT_BUBBLE_LAYOUT_PADDING_RATIO,
  MAX_BUBBLE_LAYOUT_PADDING_RATIO,
  MIN_BUBBLE_LAYOUT_PADDING_RATIO,
} from "../../shared/bubbleLayoutSettings";
import { migrateLegacyRemoteGenerationLimits } from "./appSettingsGenerationLimitMigration";
import {
  detachUnknownStylePresetGroups,
  normalizeBlockStylePresetGroups,
  normalizeBlockStylePresets,
} from "../../shared/blockStylePresets";
import { normalizeHardwareGpuSettings } from "./appSettingsHardwareNormalize";
import type { OcrNormalizationPolicy } from "./ocrRuntimeOverrides";
import { normalizeVertexAuthSettings } from "./vertexAuthSettingsNormalize";
import { normalizeCodexSettings } from "./appSettingsCodexNormalize";

export function normalizeAppSettings(
  raw: unknown,
  defaults = resolveDefaultAppSettings(),
  options: OcrNormalizationPolicy = {},
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
  const blockStylePresetGroups = normalizeBlockStylePresetGroups(
    Array.isArray(record.blockStylePresetGroups)
      ? record.blockStylePresetGroups
      : defaults.blockStylePresetGroups,
  );
  const blockStylePresets = detachUnknownStylePresetGroups(
    normalizeBlockStylePresets(
      Array.isArray(record.blockStylePresets)
        ? record.blockStylePresets
        : defaults.blockStylePresets,
    ),
    blockStylePresetGroups,
  );
  return {
    modelProvider,
    hardware: normalizeHardwareGpuSettings(asRecord(record.hardware), defaults),
    // 언어쌍이 없거나 잘못된 기존 설정은 항상 일본어 -> 한국어로 정규화된다.
    translation: resolveTranslationLanguageSettings(
      record.translation,
      defaults.translation ?? DEFAULT_TRANSLATION_LANGUAGE_SETTINGS,
    ),
    gemma: normalizeGemmaSettings(asRecord(record.gemma), defaults),
    codex,
    api,
    ocr: normalizeOcrSettings(asRecord(record.ocr), defaults, options),
    ui: normalizeUiSettings(asRecord(record.ui), defaults),
    inpainting: normalizeInpaintingSettings(
      asRecord(record.inpainting),
      defaults,
    ),
    blockFormatDefaults: normalizeBlockFormatDefaults(
      asRecord(record.blockFormatDefaults),
      defaults,
    ),
    blockStylePresets,
    blockStylePresetGroups,
    // The removed profile UI could persist an empty override when it silently
    // moved a conflicting key. Reset those legacy empties to the unified map.
    keybindings: normalizeKeybindings(
      record.keybindings,
      defaults,
      Object.hasOwn(record, "shortcutProfile"),
    ),
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
  repairLegacyProfileBindings = false,
): NonNullable<AppSettings["keybindings"]> {
  const normalized = normalizeStoredKeybindingOverrides(keybindings) ?? {
    ...(defaults.keybindings ?? {}),
  };
  if (!repairLegacyProfileBindings) return normalized;
  return Object.fromEntries(
    Object.entries(normalized).filter(([, combo]) => combo !== ""),
  );
}

function normalizeApiSettings(
  api: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["api"] {
  return {
    baseUrl: resolveOpenAiCompatibleBaseUrl(api?.baseUrl, defaults.api.baseUrl),
    model: resolveNonEmptyString(api?.model, defaults.api.model),
    ...resolveApiKeySettings(api),
    ...normalizeVertexAuthSettings(api),
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
  options: OcrNormalizationPolicy,
): AppSettings["ocr"] {
  const {
    device,
    gpuBackend,
    qualityMode: normalizedQualityMode,
  } = resolveStoredOcrModeSettings(ocr, defaults, options);
  return {
    device,
    // GPU 전용 고품질 모드는 CPU에서 못 쓸 만큼 느리므로 절약 품질로 강제한다.
    qualityMode:
      device === "cpu" && normalizedQualityMode === "full"
        ? "economy"
        : normalizedQualityMode,
    gpuBackend,
    gpuCudaTag: resolveStoredOcrGpuCudaTag(ocr, defaults),
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
    bubbleLayoutAfterInpainting: resolveBoolean(
      inpainting?.bubbleLayoutAfterInpainting,
      defaults.inpainting?.bubbleLayoutAfterInpainting ?? false,
    ),
    bubbleLayoutPaddingRatio: resolveNumberRange(
      inpainting?.bubbleLayoutPaddingRatio,
      defaults.inpainting?.bubbleLayoutPaddingRatio ??
        DEFAULT_BUBBLE_LAYOUT_PADDING_RATIO,
      MIN_BUBBLE_LAYOUT_PADDING_RATIO,
      MAX_BUBBLE_LAYOUT_PADDING_RATIO,
    ),
  };
}

export function parseStoredAppSettings(
  rawText: string | null | undefined,
  defaults = resolveDefaultAppSettings(),
  options: OcrNormalizationPolicy = {},
): AppSettings {
  if (!rawText?.trim()) {
    return defaults;
  }

  const raw = JSON.parse(rawText);
  return migrateLegacyRemoteGenerationLimits(
    raw,
    normalizeAppSettings(raw, defaults, options),
  );
}
