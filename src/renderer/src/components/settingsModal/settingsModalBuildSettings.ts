import type {
  AppSettings,
  BlockFormatDefaults,
} from "../../../../shared/settingsTypes";
import type { KeybindingOverrides } from "../../../../shared/shortcutSettings";
import { buildSettingsFromForm } from "../settingsFormBuilder";
import type { SettingsDraft } from "./settingsModalFormUtils";
import type { SettingsFormValues } from "./settingsModalFormValues";
import type {
  BlockStylePreset,
  BlockStylePresetGroup,
} from "../../../../shared/blockStylePresets";

export function buildSettingsFromDraft({
  draft,
  initialSettings,
  keybindings,
  blockFormatDefaults,
  blockStylePresetGroups,
  blockStylePresets,
  values,
}: {
  draft: SettingsDraft;
  initialSettings: AppSettings;
  keybindings: KeybindingOverrides;
  blockFormatDefaults: BlockFormatDefaults;
  blockStylePresetGroups?: BlockStylePresetGroup[];
  blockStylePresets?: BlockStylePreset[];
  values: SettingsFormValues;
}): AppSettings {
  return buildSettingsFromForm({
    initialSettings,
    graphicsGpuPreference: values.graphicsGpuPreference,
    computeGpuIndex: values.computeGpuIndex,
    uiLocale: values.uiLocale,
    keybindings,
    blockFormatDefaults,
    blockStylePresetGroups:
      blockStylePresetGroups ?? initialSettings.blockStylePresetGroups ?? [],
    blockStylePresets:
      blockStylePresets ?? initialSettings.blockStylePresets ?? [],
    modelProvider: values.modelProvider,
    sourceLanguage: values.sourceLanguage,
    targetLanguage: values.targetLanguage,
    modelSource: values.modelSource,
    modelRepo: draft.trimmedModelRepo,
    modelFile: draft.trimmedModelFile,
    mmprojRepo: draft.trimmedMmprojRepo,
    mmprojFile: draft.trimmedMmprojFile,
    localModelPath: draft.trimmedLocalModelPath,
    localMmprojPath: draft.trimmedLocalMmprojPath,
    vramMode: draft.selectedVramMode,
    llamaRuntimeProfile: values.llamaRuntimeProfile,
    allowUnsafeUnifiedMemory: values.allowUnsafeUnifiedMemory,
    codexModel: draft.trimmedCodexModel,
    codexReasoningEffort: values.codexReasoningEffort,
    codexOauthPort: draft.codexOauthPortValid
      ? draft.parsedCodexOauthPort
      : initialSettings.codex.oauthPort,
    apiBaseUrl: draft.normalizedApiBaseUrl ?? initialSettings.api.baseUrl,
    apiModel: draft.trimmedApiModel,
    apiKey: draft.trimmedApiKey,
    apiKeyMaxAttempts: draft.parsedApiKeyMaxAttempts,
    apiRetryDelaySeconds: draft.parsedApiRetryDelaySeconds,
    apiTemperature: draft.parsedApiTemperature.value,
    apiTopP: draft.parsedApiTopP.value,
    apiTopK: draft.parsedApiTopK.value,
    apiReasoningEffort: values.apiReasoningEffort || null,
    apiExtraBodyJson: values.apiExtraBodyJson.trim(),
    apiCustomHeadersJson: values.apiCustomHeadersJson.trim(),
    ocrDevice: values.ocrDevice,
    ocrGpuBackend: values.ocrGpuBackend,
    ocrQualityMode: values.ocrQualityMode,
    inpaintingModel: values.inpaintingModel,
    fluxBackend: values.fluxBackend,
    allowUnsafeLowMemoryFlux: values.allowUnsafeLowMemoryFlux,
    bubbleLayoutPaddingRatio: values.bubbleLayoutPaddingRatio,
    maxTokens: draft.parsedMaxTokens,
    ctx: draft.parsedContextTokens,
  });
}
