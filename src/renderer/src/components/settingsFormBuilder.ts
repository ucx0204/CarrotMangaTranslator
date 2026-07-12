import type {
  AppSettings,
  ApiReasoningEffort,
  BlockFormatDefaults,
  CodexReasoningEffort,
  FluxBackend,
  GemmaVramMode,
  InpaintingModel,
  KeybindingOverrides,
  LlamaRuntimeProfile,
  ModelProvider,
  ModelSource,
  OcrDevice,
  OcrGpuBackend,
  OcrQualityMode,
  UiLocale,
} from "../../../shared/settingsTypes";
import {
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_REPO,
} from "../../../shared/modelPresets";
import { resolveTranslationLanguageSettings } from "../../../shared/translationLanguages";

type BuildSettingsFromFormInput = {
  initialSettings: AppSettings;
  uiLocale: UiLocale;
  modelProvider: ModelProvider;
  sourceLanguage: string;
  targetLanguage: string;
  modelSource: ModelSource;
  modelRepo: string;
  modelFile: string;
  mmprojRepo?: string;
  mmprojFile?: string;
  localModelPath: string;
  localMmprojPath: string;
  vramMode: GemmaVramMode;
  llamaRuntimeProfile: LlamaRuntimeProfile;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  codexOauthPort: number;
  apiBaseUrl: string;
  apiModel: string;
  apiKey: string;
  apiTemperature: number | null;
  apiTopP: number | null;
  apiTopK: number | null;
  apiReasoningEffort: ApiReasoningEffort | null;
  apiExtraBodyJson: string;
  apiCustomHeadersJson: string;
  ocrDevice: OcrDevice;
  ocrGpuBackend: OcrGpuBackend;
  ocrQualityMode: OcrQualityMode;
  inpaintingModel: InpaintingModel;
  fluxBackend: FluxBackend;
  keybindings: KeybindingOverrides;
  blockFormatDefaults: BlockFormatDefaults;
  maxTokens: number;
  ctx: number;
};

export function buildSettingsFromForm(
  input: BuildSettingsFromFormInput,
): AppSettings {
  return {
    modelProvider: input.modelProvider,
    translation: resolveTranslationLanguageSettings(
      {
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
      },
      resolveTranslationLanguageSettings(input.initialSettings.translation),
    ),
    gemma: buildGemmaSettings(input),
    codex: {
      model: input.codexModel || input.initialSettings.codex.model,
      reasoningEffort: input.codexReasoningEffort,
      oauthPort: input.codexOauthPort,
    },
    api: buildApiSettings(input),
    ocr: buildOcrSettings(input),
    ui: {
      ...input.initialSettings.ui,
      locale: input.uiLocale,
    },
    inpainting: {
      ...input.initialSettings.inpainting,
      model: input.inpaintingModel,
      fluxBackend: input.fluxBackend,
      koharuBackend: input.initialSettings.inpainting?.koharuBackend ?? "auto",
    },
    keybindings: input.keybindings,
    blockFormatDefaults: input.blockFormatDefaults,
    maxTokens: input.maxTokens,
    ctx: input.ctx,
  };
}

function buildGemmaSettings(input: BuildSettingsFromFormInput) {
  const llamaRocmTarget =
    input.initialSettings.gemma.llamaRocmTarget ??
    input.initialSettings.runtimeHardware?.llamaRocmTarget ??
    undefined;
  return {
    modelSource: input.modelSource,
    modelRepo: input.modelRepo || DEFAULT_GEMMA_MODEL_REPO,
    modelFile: input.modelFile || DEFAULT_GEMMA_MODEL_FILE,
    ...(input.mmprojRepo ? { mmprojRepo: input.mmprojRepo } : {}),
    ...(input.mmprojFile ? { mmprojFile: input.mmprojFile } : {}),
    ...(input.localModelPath ? { localModelPath: input.localModelPath } : {}),
    ...(input.localMmprojPath
      ? { localMmprojPath: input.localMmprojPath }
      : {}),
    vramMode: input.vramMode,
    llamaRuntimeProfile: input.llamaRuntimeProfile,
    ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
  };
}

function buildOcrSettings(input: BuildSettingsFromFormInput) {
  return {
    device: input.ocrDevice,
    qualityMode: input.ocrQualityMode,
    gpuBackend: input.ocrGpuBackend,
    ...(input.initialSettings.ocr.gpuCudaTag
      ? { gpuCudaTag: input.initialSettings.ocr.gpuCudaTag }
      : {}),
  };
}

function buildApiSettings(input: BuildSettingsFromFormInput) {
  return {
    baseUrl: input.apiBaseUrl || input.initialSettings.api.baseUrl,
    model: input.apiModel || input.initialSettings.api.model,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    temperature: input.apiTemperature,
    topP: input.apiTopP,
    topK: input.apiTopK,
    reasoningEffort: input.apiReasoningEffort,
    extraBodyJson: input.apiExtraBodyJson,
    customHeadersJson: input.apiCustomHeadersJson,
  };
}
