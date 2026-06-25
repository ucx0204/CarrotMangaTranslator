import type {
  AppSettings,
  BlockFormatDefaults,
  KeybindingOverrides,
} from "../../../../shared/settingsTypes";
import { buildSettingsFromForm } from "../settingsFormBuilder";
import type {
  SettingsDraft,
  SettingsFormValues,
} from "./settingsModalFormUtils";

export function buildSettingsFromDraft({
  draft,
  initialSettings,
  keybindings,
  blockFormatDefaults,
  values,
}: {
  draft: SettingsDraft;
  initialSettings: AppSettings;
  keybindings: KeybindingOverrides;
  blockFormatDefaults: BlockFormatDefaults;
  values: SettingsFormValues;
}): AppSettings {
  return buildSettingsFromForm({
    initialSettings,
    keybindings,
    blockFormatDefaults,
    modelProvider: values.modelProvider,
    modelSource: values.modelSource,
    modelRepo: draft.trimmedModelRepo,
    modelFile: draft.trimmedModelFile,
    mmprojRepo: draft.trimmedMmprojRepo,
    mmprojFile: draft.trimmedMmprojFile,
    localModelPath: draft.trimmedLocalModelPath,
    localMmprojPath: draft.trimmedLocalMmprojPath,
    vramMode: draft.selectedVramMode,
    llamaRuntimeProfile: values.llamaRuntimeProfile,
    codexModel: draft.trimmedCodexModel,
    codexReasoningEffort: values.codexReasoningEffort,
    codexOauthPort: draft.codexOauthPortValid
      ? draft.parsedCodexOauthPort
      : initialSettings.codex.oauthPort,
    apiBaseUrl: draft.normalizedApiBaseUrl ?? initialSettings.api.baseUrl,
    apiModel: draft.trimmedApiModel,
    apiKey: draft.trimmedApiKey,
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
    maxTokens: draft.parsedMaxTokens,
    ctx: draft.parsedContextTokens,
  });
}
