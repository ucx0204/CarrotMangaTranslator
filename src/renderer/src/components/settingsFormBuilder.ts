import type {
  AppSettings,
  ApiReasoningEffort,
  BlockFormatDefaults,
  CodexReasoningEffort,
  FluxBackend,
  GemmaVramMode,
  InpaintingModel,
  LlamaRuntimeProfile,
  ModelProvider,
  ModelSource,
  OcrDevice,
  OcrGpuBackend,
  OcrPipeline,
  OcrQualityMode,
  UiLocale,
  WheelZoomSensitivityPercent,
} from "../../../shared/settingsTypes";
import type {
  ResearchGemmaPreset,
  ResearchGemmaReasoningEffort,
  TavilyAnalysisProvider,
} from "../../../shared/internetResearchTypes";
import type { GraphicsGpuPreference } from "../../../shared/gpuSettings";
import type { KeybindingOverrides } from "../../../shared/shortcutSettings";
import {
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_REPO,
} from "../../../shared/modelPresets";
import { resolveTranslationLanguageSettings } from "../../../shared/translationLanguages";
import type {
  BlockStylePreset,
  BlockStylePresetGroup,
} from "../../../shared/blockStylePresets";

type BuildSettingsFromFormInput = {
  initialSettings: AppSettings;
  graphicsGpuPreference: GraphicsGpuPreference;
  computeGpuIndex: number | null;
  uiLocale: UiLocale;
  wheelZoomSensitivityPercent: WheelZoomSensitivityPercent;
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
  fitTargetMb: number;
  mmprojOffload: boolean;
  llamaRuntimeProfile: LlamaRuntimeProfile;
  allowUnsafeUnifiedMemory: boolean;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  researchTavilyAnalysisProvider: TavilyAnalysisProvider;
  researchGemmaPreset: ResearchGemmaPreset;
  researchGemmaReasoningEffort: ResearchGemmaReasoningEffort;
  researchGemmaMaxOutputTokens: number;
  researchGemmaContextTokens: number;
  researchApiModel: string;
  researchApiMaxOutputTokens: number;
  researchApiContextTokens: number;
  researchCodexModel: string;
  researchCodexReasoningEffort: CodexReasoningEffort;
  researchCodexMaxOutputTokens: number;
  researchCodexContextTokens: number;
  tavilyApiKey: string;
  tavilyMaxCreditsPerRun: number;
  apiBaseUrl: string;
  apiModel: string;
  apiKey: string;
  apiVertexAuthMode: import("../../../shared/apiProviderPresets").VertexAuthMode;
  apiVertexServiceAccountPath: string;
  apiKeyMaxAttempts: number;
  apiRetryDelaySeconds: number;
  apiTemperature: number | null;
  apiTopP: number | null;
  apiTopK: number | null;
  apiReasoningEffort: ApiReasoningEffort | null;
  apiExtraBodyJson: string;
  apiCustomHeadersJson: string;
  ocrDevice: OcrDevice;
  ocrPipeline: OcrPipeline;
  ocrGpuBackend: OcrGpuBackend;
  ocrQualityMode: OcrQualityMode;
  inpaintingModel: InpaintingModel;
  fluxBackend: FluxBackend;
  allowUnsafeLowMemoryFlux: boolean;
  bubbleLayoutPaddingRatio: number;
  keybindings: KeybindingOverrides;
  blockFormatDefaults: BlockFormatDefaults;
  blockStylePresetGroups?: BlockStylePresetGroup[];
  blockStylePresets: BlockStylePreset[];
  maxTokens: number;
  ctx: number;
};

export function buildSettingsFromForm(
  input: BuildSettingsFromFormInput,
): AppSettings {
  return {
    modelProvider: input.modelProvider,
    hardware: {
      graphicsGpuPreference: input.graphicsGpuPreference,
      ...(input.computeGpuIndex === null
        ? {}
        : { computeGpuIndex: input.computeGpuIndex }),
    },
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
    },
    internetResearch: {
      tavilyAnalysisProvider: input.researchTavilyAnalysisProvider,
      gemmaPreset: input.researchGemmaPreset,
      gemmaReasoningEffort: input.researchGemmaReasoningEffort,
      gemmaMaxOutputTokens: input.researchGemmaMaxOutputTokens,
      gemmaContextTokens: input.researchGemmaContextTokens,
      apiModel:
        input.researchApiModel ||
        input.initialSettings.internetResearch.apiModel,
      apiMaxOutputTokens: input.researchApiMaxOutputTokens,
      apiContextTokens: input.researchApiContextTokens,
      codexModel:
        input.researchCodexModel ||
        input.initialSettings.internetResearch.codexModel,
      codexReasoningEffort: input.researchCodexReasoningEffort,
      codexMaxOutputTokens: input.researchCodexMaxOutputTokens,
      codexContextTokens: input.researchCodexContextTokens,
      ...(input.tavilyApiKey ? { tavilyApiKey: input.tavilyApiKey } : {}),
      tavilyMaxCreditsPerRun: input.tavilyMaxCreditsPerRun,
    },
    api: buildApiSettings(input),
    ocr: buildOcrSettings(input),
    ui: {
      ...input.initialSettings.ui,
      locale: input.uiLocale,
      wheelZoomSensitivityPercent: input.wheelZoomSensitivityPercent,
    },
    inpainting: {
      ...input.initialSettings.inpainting,
      model: input.inpaintingModel,
      fluxBackend: input.fluxBackend,
      allowUnsafeLowMemoryFlux: input.allowUnsafeLowMemoryFlux,
      bubbleLayoutPaddingRatio: input.bubbleLayoutPaddingRatio,
      koharuBackend: input.initialSettings.inpainting?.koharuBackend ?? "auto",
    },
    keybindings: input.keybindings,
    blockFormatDefaults: input.blockFormatDefaults,
    blockStylePresetGroups:
      input.blockStylePresetGroups ??
      input.initialSettings.blockStylePresetGroups ??
      [],
    blockStylePresets: input.blockStylePresets,
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
    fitTargetMb: input.fitTargetMb,
    mmprojOffload: input.mmprojOffload,
    llamaRuntimeProfile: input.llamaRuntimeProfile,
    allowUnsafeUnifiedMemory: input.allowUnsafeUnifiedMemory,
    ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
  };
}

function buildOcrSettings(input: BuildSettingsFromFormInput) {
  return {
    pipeline: input.ocrPipeline,
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
    vertexAuthMode: input.apiVertexAuthMode,
    ...(input.apiVertexServiceAccountPath
      ? { vertexServiceAccountPath: input.apiVertexServiceAccountPath }
      : {}),
    keyMaxAttempts: input.apiKeyMaxAttempts,
    retryDelaySeconds: input.apiRetryDelaySeconds,
    temperature: input.apiTemperature,
    topP: input.apiTopP,
    topK: input.apiTopK,
    reasoningEffort: input.apiReasoningEffort,
    extraBodyJson: input.apiExtraBodyJson,
    customHeadersJson: input.apiCustomHeadersJson,
  };
}
