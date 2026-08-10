import type {
  ApiReasoningEffort,
  AppSettings,
  CodexReasoningEffort,
  FluxBackend,
  GemmaVramMode,
  InpaintingModel,
  LlamaRuntimeProfile,
  ModelProvider,
  ModelSource,
  OcrDevice,
  OcrGpuBackend,
  OcrQualityMode,
  UiLocale,
} from "../../../../shared/settingsTypes";
import type { GraphicsGpuPreference } from "../../../../shared/gpuSettings";
import {
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
  normalizeLanguageCode,
} from "../../../../shared/translationLanguages";
import {
  DEFAULT_UI_LOCALE,
  normalizeUiLocale,
} from "../../../../shared/uiLocales";
import {
  resolveCodexReasoningEffortForModel,
  resolveModelPreset,
  type ModelPresetId,
} from "../settingsOptions";
import {
  DEFAULT_API_KEY_MAX_ATTEMPTS,
  DEFAULT_API_RETRY_DELAY_SECONDS,
} from "../../../../shared/apiKeySettings";
import { DEFAULT_BUBBLE_LAYOUT_PADDING_RATIO } from "../../../../shared/bubbleLayoutSettings";

export type SettingsFormValues = {
  uiLocale: UiLocale;
  graphicsGpuPreference: GraphicsGpuPreference;
  computeGpuIndex: number | null;
  modelProvider: ModelProvider;
  sourceLanguage: string;
  targetLanguage: string;
  modelSource: ModelSource;
  selectedPreset: ModelPresetId;
  customModelRepo: string;
  customModelFile: string;
  localModelPath: string;
  localMmprojPath: string;
  customVramMode: GemmaVramMode;
  llamaRuntimeProfile: LlamaRuntimeProfile;
  allowUnsafeUnifiedMemory: boolean;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  codexOauthPort: string;
  apiBaseUrl: string;
  apiModel: string;
  apiKey: string;
  apiKeyMaxAttempts: string;
  apiRetryDelaySeconds: string;
  apiTemperature: string;
  apiTopP: string;
  apiTopK: string;
  apiReasoningEffort: ApiReasoningEffort | "";
  apiExtraBodyJson: string;
  apiCustomHeadersJson: string;
  ocrDevice: OcrDevice;
  ocrGpuBackend: OcrGpuBackend;
  ocrQualityMode: OcrQualityMode;
  inpaintingModel: InpaintingModel;
  fluxBackend: FluxBackend;
  allowUnsafeLowMemoryFlux: boolean;
  bubbleLayoutPaddingRatio: number;
  maxTokens: string;
  contextTokens: string;
};

export function createSettingsFormValues(
  settings: AppSettings,
): SettingsFormValues {
  return {
    ...resolveGeneralFormValues(settings),
    ...resolveModelFormValues(settings),
    ...resolveApiFormValues(settings),
    ...resolveGpuFormValues(settings),
    ...resolveHardwareFormValues(settings),
    maxTokens: String(settings.maxTokens),
    contextTokens: String(settings.ctx),
  };
}

function resolveGeneralFormValues(
  settings: AppSettings,
): Pick<
  SettingsFormValues,
  "uiLocale" | "modelProvider" | "sourceLanguage" | "targetLanguage"
> {
  return {
    uiLocale: normalizeUiLocale(settings.ui?.locale, DEFAULT_UI_LOCALE),
    modelProvider: settings.modelProvider,
    sourceLanguage: normalizeLanguageCode(
      settings.translation?.sourceLanguage,
      DEFAULT_SOURCE_LANGUAGE,
    ),
    targetLanguage: normalizeLanguageCode(
      settings.translation?.targetLanguage,
      DEFAULT_TARGET_LANGUAGE,
    ),
  };
}

function resolveModelFormValues(
  settings: AppSettings,
): Pick<
  SettingsFormValues,
  | "modelSource"
  | "selectedPreset"
  | "customModelRepo"
  | "customModelFile"
  | "localModelPath"
  | "localMmprojPath"
  | "customVramMode"
  | "llamaRuntimeProfile"
  | "allowUnsafeUnifiedMemory"
  | "codexModel"
  | "codexReasoningEffort"
  | "codexOauthPort"
> {
  return {
    modelSource: settings.gemma.modelSource,
    selectedPreset: resolveModelPreset(
      settings.gemma.modelRepo,
      settings.gemma.modelFile,
    ),
    customModelRepo: settings.gemma.modelRepo,
    customModelFile: settings.gemma.modelFile,
    localModelPath: settings.gemma.localModelPath ?? "",
    localMmprojPath: settings.gemma.localMmprojPath ?? "",
    customVramMode: settings.gemma.vramMode,
    llamaRuntimeProfile: settings.gemma.llamaRuntimeProfile ?? "cuda12",
    allowUnsafeUnifiedMemory: settings.gemma.allowUnsafeUnifiedMemory === true,
    codexModel: settings.codex.model,
    codexReasoningEffort: resolveCodexReasoningEffortForModel(
      settings.codex.model,
      settings.codex.reasoningEffort,
    ),
    codexOauthPort: String(settings.codex.oauthPort),
  };
}

function resolveApiFormValues(
  settings: AppSettings,
): Pick<
  SettingsFormValues,
  | "apiBaseUrl"
  | "apiModel"
  | "apiKey"
  | "apiKeyMaxAttempts"
  | "apiRetryDelaySeconds"
  | "apiTemperature"
  | "apiTopP"
  | "apiTopK"
  | "apiReasoningEffort"
  | "apiExtraBodyJson"
  | "apiCustomHeadersJson"
> {
  return {
    apiBaseUrl: settings.api.baseUrl,
    apiModel: settings.api.model,
    apiKey: settings.api.apiKey ?? "",
    apiKeyMaxAttempts: String(
      settings.api.keyMaxAttempts ?? DEFAULT_API_KEY_MAX_ATTEMPTS,
    ),
    apiRetryDelaySeconds: String(
      settings.api.retryDelaySeconds ?? DEFAULT_API_RETRY_DELAY_SECONDS,
    ),
    apiTemperature: formatNullableNumberInput(settings.api.temperature),
    apiTopP: formatNullableNumberInput(settings.api.topP),
    apiTopK: formatNullableNumberInput(settings.api.topK),
    apiReasoningEffort: settings.api.reasoningEffort ?? "",
    apiExtraBodyJson: settings.api.extraBodyJson ?? "",
    apiCustomHeadersJson: settings.api.customHeadersJson ?? "",
  };
}

function resolveHardwareFormValues(
  settings: AppSettings,
): Pick<
  SettingsFormValues,
  | "ocrDevice"
  | "ocrGpuBackend"
  | "ocrQualityMode"
  | "inpaintingModel"
  | "fluxBackend"
  | "allowUnsafeLowMemoryFlux"
  | "bubbleLayoutPaddingRatio"
> {
  return {
    ocrDevice: settings.ocr.device,
    ocrGpuBackend: settings.ocr.gpuBackend ?? "cuda",
    ocrQualityMode: settings.ocr.qualityMode ?? "economy",
    inpaintingModel: settings.inpainting?.model ?? "flux-klein",
    fluxBackend: settings.inpainting?.fluxBackend ?? "cuda-native",
    allowUnsafeLowMemoryFlux:
      settings.inpainting?.allowUnsafeLowMemoryFlux === true,
    bubbleLayoutPaddingRatio:
      settings.inpainting?.bubbleLayoutPaddingRatio ??
      DEFAULT_BUBBLE_LAYOUT_PADDING_RATIO,
  };
}

function resolveGpuFormValues(
  settings: AppSettings,
): Pick<SettingsFormValues, "graphicsGpuPreference" | "computeGpuIndex"> {
  return {
    graphicsGpuPreference: settings.hardware?.graphicsGpuPreference ?? "auto",
    computeGpuIndex: settings.hardware?.computeGpuIndex ?? null,
  };
}

function formatNullableNumberInput(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}
