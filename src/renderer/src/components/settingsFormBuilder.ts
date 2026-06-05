import type {
  AppSettings,
  CodexReasoningEffort,
  GemmaVramMode,
  ModelProvider,
  ModelSource,
  OcrDevice
} from "../../../shared/types";
import {
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_REPO
} from "../../../shared/modelPresets";

type BuildSettingsFromFormInput = {
  initialSettings: AppSettings;
  modelProvider: ModelProvider;
  modelSource: ModelSource;
  modelRepo: string;
  modelFile: string;
  mmprojRepo?: string;
  mmprojFile?: string;
  localModelPath: string;
  localMmprojPath: string;
  vramMode: GemmaVramMode;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  codexOauthPort: number;
  ocrDevice: OcrDevice;
  maxTokens: number;
};

export function buildSettingsFromForm(input: BuildSettingsFromFormInput): AppSettings {
  const gemma = {
    modelSource: input.modelSource,
    modelRepo: input.modelRepo || DEFAULT_GEMMA_MODEL_REPO,
    modelFile: input.modelFile || DEFAULT_GEMMA_MODEL_FILE,
    ...(input.mmprojRepo ? { mmprojRepo: input.mmprojRepo } : {}),
    ...(input.mmprojFile ? { mmprojFile: input.mmprojFile } : {}),
    ...(input.localModelPath ? { localModelPath: input.localModelPath } : {}),
    ...(input.localMmprojPath ? { localMmprojPath: input.localMmprojPath } : {}),
    vramMode: input.vramMode,
    ...(input.initialSettings.gemma.llamaRuntimeProfile
      ? { llamaRuntimeProfile: input.initialSettings.gemma.llamaRuntimeProfile }
      : {})
  };
  const ocr = {
    device: input.ocrDevice,
    ...(input.initialSettings.ocr.gpuCudaTag ? { gpuCudaTag: input.initialSettings.ocr.gpuCudaTag } : {})
  };

  return {
    modelProvider: input.modelProvider,
    gemma,
    codex: {
      model: input.codexModel || input.initialSettings.codex.model,
      reasoningEffort: input.codexReasoningEffort,
      oauthPort: input.codexOauthPort
    },
    ocr,
    ui: input.initialSettings.ui,
    maxTokens: input.maxTokens
  };
}

