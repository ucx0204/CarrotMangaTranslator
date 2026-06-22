import type React from "react";
import type {
  ApiReasoningEffort,
  CodexReasoningEffort,
  GemmaVramMode,
  LlamaRuntimeProfile,
  ModelProvider,
  ModelSource,
} from "../../../../shared/settingsTypes";
import type { ModelPresetId } from "../settingsOptions";

export type EngineSettingsPanelProps = {
  apiBaseUrl: string;
  apiKey: string;
  apiModel: string;
  apiTemperature: string;
  apiTopP: string;
  apiTopK: string;
  apiReasoningEffort: ApiReasoningEffort | "";
  apiExtraBodyJson: string;
  apiCustomHeadersJson: string;
  clearTestState: () => void;
  codexModel: string;
  codexOauthPort: string;
  codexReasoningEffort: CodexReasoningEffort;
  contextTokens: string;
  controlsBusy: boolean;
  customModelFile: string;
  customModelRepo: string;
  isLlamaRuntimeOptionDisabled: (profile: LlamaRuntimeProfile) => boolean;
  llamaRuntimeProfile: LlamaRuntimeProfile;
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
  setCodexOauthPort: React.Dispatch<React.SetStateAction<string>>;
  setCodexReasoningEffort: React.Dispatch<
    React.SetStateAction<CodexReasoningEffort>
  >;
  setContextTokens: React.Dispatch<React.SetStateAction<string>>;
  setCustomModelFile: React.Dispatch<React.SetStateAction<string>>;
  setCustomModelRepo: React.Dispatch<React.SetStateAction<string>>;
  setCustomVramMode: React.Dispatch<React.SetStateAction<GemmaVramMode>>;
  setLlamaRuntimeProfile: React.Dispatch<
    React.SetStateAction<LlamaRuntimeProfile>
  >;
  setLocalMmprojPath: React.Dispatch<React.SetStateAction<string>>;
  setLocalModelPath: React.Dispatch<React.SetStateAction<string>>;
  setMaxTokens: React.Dispatch<React.SetStateAction<string>>;
  setModelProvider: React.Dispatch<React.SetStateAction<ModelProvider>>;
  setModelSource: React.Dispatch<React.SetStateAction<ModelSource>>;
  setSelectedPreset: React.Dispatch<React.SetStateAction<ModelPresetId>>;
  setApiBaseUrl: React.Dispatch<React.SetStateAction<string>>;
  setApiCustomHeadersJson: React.Dispatch<React.SetStateAction<string>>;
  setApiExtraBodyJson: React.Dispatch<React.SetStateAction<string>>;
  setApiKey: React.Dispatch<React.SetStateAction<string>>;
  setApiModel: React.Dispatch<React.SetStateAction<string>>;
  setApiReasoningEffort: React.Dispatch<
    React.SetStateAction<ApiReasoningEffort | "">
  >;
  setApiTemperature: React.Dispatch<React.SetStateAction<string>>;
  setApiTopK: React.Dispatch<React.SetStateAction<string>>;
  setApiTopP: React.Dispatch<React.SetStateAction<string>>;
  submit: () => void;
  usesAmdHardware: boolean;
  usesNvidiaHardware: boolean;
};
