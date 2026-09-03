import type { AppSettings } from "../../shared/settingsTypes";
import {
  DEFAULT_TRANSLATION_LANGUAGE_SETTINGS,
  resolveTranslationLanguageSettings,
} from "../../shared/translationLanguages";
import {
  asRecord,
  resolveBoolean,
  resolveModelProvider,
  resolveNumberRange,
  resolveOcrPipeline,
} from "./appSettingsResolvers";
import { resolveDefaultAppSettings } from "./appSettingsDefaults";
import {
  resolveStoredFluxBackend,
  resolveStoredInpaintingModel,
  resolveStoredKoharuInpaintingBackend,
  resolveStoredOcrGpuCudaTag,
  resolveStoredOcrModeSettings,
} from "./appSettingsStoredResolvers";
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
import { normalizeCodexSettings } from "./appSettingsCodexNormalize";
import { normalizeInternetResearchSettings } from "./appSettingsInternetResearchNormalize";
import {
  normalizeApiSettings,
  normalizeGenerationLimitProfiles,
  resolveActiveGenerationLimits,
} from "./appSettingsProviderProfiles";

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
  const generationLimits = normalizeGenerationLimitProfiles({
    api,
    codex,
    defaults,
    modelProvider,
    raw: record.generationLimits,
    rawMaxTokens: record.maxTokens,
    rawContextTokens: record.ctx,
  });
  const activeLimits = resolveActiveGenerationLimits(
    generationLimits,
    modelProvider,
    api.provider,
  );
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
    internetResearch: normalizeInternetResearchSettings(
      record.internetResearch,
      defaults.internetResearch,
      api,
    ),
    api,
    ocr: normalizeOcrSettings(asRecord(record.ocr), defaults),
    ui: normalizeUiSettings(
      asRecord(record.ui),
      defaults,
      asRecord(record.blockFormatDefaults)?.autoFitText,
    ),
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
    generationLimits,
    maxTokens: activeLimits.maxTokens,
    ctx: activeLimits.contextTokens,
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

function normalizeOcrSettings(
  ocr: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["ocr"] {
  const {
    device,
    gpuBackend,
    qualityMode: normalizedQualityMode,
  } = resolveStoredOcrModeSettings(ocr, defaults);
  return {
    pipeline: resolveOcrPipeline(
      ocr?.pipeline,
      defaults.ocr.pipeline ?? (device === "gpu" ? "hayai" : "paddle-legacy"),
    ),
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
): AppSettings {
  if (!rawText?.trim()) {
    return defaults;
  }

  const raw = JSON.parse(rawText);
  return migrateLegacyRemoteGenerationLimits(
    raw,
    normalizeAppSettings(raw, defaults),
  );
}
