import type React from "react";
import type {
  ApiReasoningEffort,
  CodexReasoningEffort,
  GemmaVramMode,
  LlamaRuntimeProfile,
  ModelProvider,
  ModelSource,
} from "../../../../shared/settingsTypes";
import type { VertexAuthMode } from "../../../../shared/apiProviderPresets";
import type { ApiProviderPresetId } from "../../../../shared/apiProviderPresets";
import type { ModelPresetId } from "../settingsOptions";

export type EngineSettingsPanelProps = {
  apiBaseUrl: string;
  apiProvider: ApiProviderPresetId;
  apiKey: string;
  apiKeyCount: number;
  apiVertexAuthMode: VertexAuthMode;
  apiVertexServiceAccountPath: string;
  apiKeyMaxAttempts: string;
  apiRetryDelaySeconds: string;
  apiModel: string;
  apiTemperature: string;
  apiTopP: string;
  apiTopK: string;
  apiReasoningEffort: ApiReasoningEffort | "";
  apiExtraBodyJson: string;
  apiCustomHeadersJson: string;
  clearTestState: () => void;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  contextTokens: string;
  controlsBusy: boolean;
  detectedGpuName?: string | null;
  gpuMemoryMb: number | null;
  customModelFile: string;
  customModelRepo: string;
  gemmaFitTargetMb: number;
  gemmaMmprojOffload: boolean;
  isLlamaRuntimeOptionDisabled: (profile: LlamaRuntimeProfile) => boolean;
  llamaRuntimeProfile: LlamaRuntimeProfile;
  allowUnsafeUnifiedMemory: boolean;
  unifiedMemoryMb: number | null;
  localMmprojPath: string;
  localModelInputRef: React.RefObject<HTMLInputElement | null>;
  localModelPath: string;
  maxTokens: string;
  modelProvider: ModelProvider;
  modelRepoInputRef: React.RefObject<HTMLInputElement | null>;
  modelSource: ModelSource;
  pickLocalMmprojFile: () => Promise<void>;
  pickLocalModelFile: () => Promise<void>;
  selectedPreset: ModelPresetId;
  setCodexModel: React.Dispatch<React.SetStateAction<string>>;
  setCodexReasoningEffort: React.Dispatch<
    React.SetStateAction<CodexReasoningEffort>
  >;
  setContextTokens: React.Dispatch<React.SetStateAction<string>>;
  setCustomModelFile: React.Dispatch<React.SetStateAction<string>>;
  setCustomModelRepo: React.Dispatch<React.SetStateAction<string>>;
  setCustomVramMode: React.Dispatch<React.SetStateAction<GemmaVramMode>>;
  setGemmaFitTargetMb: React.Dispatch<React.SetStateAction<number>>;
  setGemmaMmprojOffload: React.Dispatch<React.SetStateAction<boolean>>;
  setLlamaRuntimeProfile: React.Dispatch<
    React.SetStateAction<LlamaRuntimeProfile>
  >;
  setAllowUnsafeUnifiedMemory: React.Dispatch<React.SetStateAction<boolean>>;
  setLocalMmprojPath: React.Dispatch<React.SetStateAction<string>>;
  setLocalModelPath: React.Dispatch<React.SetStateAction<string>>;
  setMaxTokens: React.Dispatch<React.SetStateAction<string>>;
  setModelProvider: React.Dispatch<React.SetStateAction<ModelProvider>>;
  setModelSource: React.Dispatch<React.SetStateAction<ModelSource>>;
  setSourceLanguage: React.Dispatch<React.SetStateAction<string>>;
  setTargetLanguage: React.Dispatch<React.SetStateAction<string>>;
  sourceLanguage: string;
  targetLanguage: string;
  setSelectedPreset: React.Dispatch<React.SetStateAction<ModelPresetId>>;
  setApiBaseUrl: React.Dispatch<React.SetStateAction<string>>;
  setApiProvider: React.Dispatch<React.SetStateAction<ApiProviderPresetId>>;
  setApiCustomHeadersJson: React.Dispatch<React.SetStateAction<string>>;
  setApiExtraBodyJson: React.Dispatch<React.SetStateAction<string>>;
  setApiKey: React.Dispatch<React.SetStateAction<string>>;
  setApiVertexAuthMode: React.Dispatch<React.SetStateAction<VertexAuthMode>>;
  setApiVertexServiceAccountPath: React.Dispatch<React.SetStateAction<string>>;
  setApiKeyMaxAttempts: React.Dispatch<React.SetStateAction<string>>;
  setApiRetryDelaySeconds: React.Dispatch<React.SetStateAction<string>>;
  setApiModel: React.Dispatch<React.SetStateAction<string>>;
  setApiReasoningEffort: React.Dispatch<
    React.SetStateAction<ApiReasoningEffort | "">
  >;
  setApiTemperature: React.Dispatch<React.SetStateAction<string>>;
  setApiTopK: React.Dispatch<React.SetStateAction<string>>;
  setApiTopP: React.Dispatch<React.SetStateAction<string>>;
  submit: () => void;
  usesAmdHardware: boolean;
  usesAppleHardware: boolean;
  usesNvidiaHardware: boolean;
  usesRtx50Hardware: boolean;
};
