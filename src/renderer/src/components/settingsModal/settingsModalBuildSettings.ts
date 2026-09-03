import type {
  AppSettings,
  ApiProviderProfileSettings,
  BlockFormatDefaults,
  GenerationLimitProfiles,
} from "../../../../shared/settingsTypes";
import type { KeybindingOverrides } from "../../../../shared/shortcutSettings";
import { buildSettingsFromForm } from "../settingsFormBuilder";
import type { SettingsDraft } from "./settingsModalFormUtils";
import type { SettingsFormValues } from "./settingsModalFormValues";
import type {
  BlockStylePreset,
  BlockStylePresetGroup,
} from "../../../../shared/blockStylePresets";
import { API_PROVIDER_PRESET_IDS } from "../../../../shared/apiProviderPresets";
import { coerceOpenAiCompatibleBaseUrl } from "../../../../shared/apiSettings";
import { normalizeApiKeysText } from "../../../../shared/apiKeySettings";
import { resolveRecommendedGenerationLimits } from "../../../../shared/modelPresets";
import type {
  ApiProfileFormValues,
  GenerationLimitFormValues,
  ResearchApiProfileFormValues,
} from "./settingsModalProfileFormValues";

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
    wheelZoomSensitivityPercent: values.wheelZoomSensitivityPercent,
    keybindings,
    blockFormatDefaults,
    ...resolveBlockStyleCollections(
      initialSettings,
      blockStylePresetGroups,
      blockStylePresets,
    ),
    modelProvider: values.modelProvider,
    generationLimits: buildGenerationLimitProfiles(values, initialSettings),
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
    fitTargetMb: values.gemmaFitTargetMb,
    mmprojOffload: values.gemmaMmprojOffload,
    llamaRuntimeProfile: values.llamaRuntimeProfile,
    allowUnsafeUnifiedMemory: values.allowUnsafeUnifiedMemory,
    codexModel: draft.trimmedCodexModel,
    codexReasoningEffort: values.codexReasoningEffort,
    ...buildInternetResearchFields(draft, values),
    apiBaseUrl: draft.normalizedApiBaseUrl ?? initialSettings.api.baseUrl,
    apiProvider: values.apiProvider,
    apiProfiles: buildApiProfiles(values, initialSettings),
    apiModel: draft.trimmedApiModel,
    apiKey: draft.trimmedApiKey,
    apiVertexAuthMode: values.apiVertexAuthMode,
    apiVertexServiceAccountPath: draft.trimmedApiVertexServiceAccountPath,
    apiKeyMaxAttempts: draft.parsedApiKeyMaxAttempts,
    apiRetryDelaySeconds: draft.parsedApiRetryDelaySeconds,
    apiTemperature: draft.parsedApiTemperature.value,
    apiTopP: draft.parsedApiTopP.value,
    apiTopK: draft.parsedApiTopK.value,
    apiReasoningEffort: values.apiReasoningEffort || null,
    apiExtraBodyJson: values.apiExtraBodyJson.trim(),
    apiCustomHeadersJson: values.apiCustomHeadersJson.trim(),
    ocrDevice: values.ocrDevice,
    ocrPipeline: values.ocrPipeline,
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

function buildInternetResearchFields(
  draft: SettingsDraft,
  values: SettingsFormValues,
) {
  return {
    researchTavilyAnalysisProvider: values.researchTavilyAnalysisProvider,
    researchGemmaPreset: values.researchGemmaPreset,
    researchGemmaReasoningEffort: values.researchGemmaReasoningEffort,
    researchGemmaMaxOutputTokens: draft.parsedResearchGemmaMaxOutputTokens,
    researchGemmaContextTokens: draft.parsedResearchGemmaContextTokens,
    researchApiModel: draft.trimmedResearchApiModel,
    researchApiMaxOutputTokens: draft.parsedResearchApiMaxOutputTokens,
    researchApiContextTokens: draft.parsedResearchApiContextTokens,
    researchApiProfiles: buildResearchApiProfiles(values),
    researchCodexModel: draft.trimmedResearchCodexModel,
    researchCodexReasoningEffort: values.researchCodexReasoningEffort,
    researchCodexMaxOutputTokens: draft.parsedResearchCodexMaxOutputTokens,
    researchCodexContextTokens: draft.parsedResearchCodexContextTokens,
    tavilyApiKey: draft.trimmedTavilyApiKey,
    tavilyMaxCreditsPerRun: draft.parsedTavilyMaxCreditsPerRun,
  };
}

function buildApiProfiles(
  values: SettingsFormValues,
  initialSettings: AppSettings,
): AppSettings["api"]["profiles"] {
  const profiles: AppSettings["api"]["profiles"] = {};
  for (const provider of API_PROVIDER_PRESET_IDS) {
    const parsed = parseApiProfile(values.apiProfiles[provider]);
    const fallback = initialSettings.api.profiles?.[provider];
    if (parsed) profiles[provider] = parsed;
    else if (fallback) profiles[provider] = fallback;
  }
  return profiles;
}

function parseApiProfile(
  profile: ApiProfileFormValues | undefined,
): ApiProviderProfileSettings | null {
  if (!profile) return null;
  const baseUrl = coerceOpenAiCompatibleBaseUrl(profile.apiBaseUrl);
  const model = profile.apiModel.trim();
  const keyMaxAttempts = Number(profile.apiKeyMaxAttempts);
  const retryDelaySeconds = Number(profile.apiRetryDelaySeconds);
  if (
    !baseUrl ||
    !model ||
    !Number.isFinite(keyMaxAttempts) ||
    !Number.isFinite(retryDelaySeconds)
  ) {
    return null;
  }
  const apiKey = normalizeApiKeysText(profile.apiKey);
  return {
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    vertexAuthMode: profile.apiVertexAuthMode,
    ...(profile.apiVertexServiceAccountPath.trim()
      ? { vertexServiceAccountPath: profile.apiVertexServiceAccountPath.trim() }
      : {}),
    keyMaxAttempts: Math.round(keyMaxAttempts),
    retryDelaySeconds,
    temperature: parseOptionalNumber(profile.apiTemperature),
    topP: parseOptionalNumber(profile.apiTopP),
    topK: parseOptionalNumber(profile.apiTopK),
    reasoningEffort: profile.apiReasoningEffort || null,
    extraBodyJson: profile.apiExtraBodyJson.trim(),
    customHeadersJson: profile.apiCustomHeadersJson.trim(),
  };
}

function buildGenerationLimitProfiles(
  values: SettingsFormValues,
  initialSettings: AppSettings,
): GenerationLimitProfiles {
  const profiles = snapshotActiveGenerationLimit(values);
  const api: GenerationLimitProfiles["api"] = {};
  const initialProfiles = initialSettings.generationLimits;
  for (const provider of API_PROVIDER_PRESET_IDS) {
    const parsed = parseGenerationLimits(profiles.api[provider]);
    const fallback = initialProfiles?.api[provider];
    if (parsed) api[provider] = parsed;
    else if (fallback) api[provider] = fallback;
  }
  return {
    gemma:
      parseGenerationLimits(profiles.gemma) ??
      initialProfiles?.gemma ??
      resolveRecommendedGenerationLimits("gemma"),
    codex:
      parseGenerationLimits(profiles.codex) ??
      initialProfiles?.codex ??
      resolveRecommendedGenerationLimits(
        "openai-codex",
        initialSettings.codex.model,
      ),
    api,
  };
}

function snapshotActiveGenerationLimit(
  values: SettingsFormValues,
): SettingsFormValues["generationLimitProfiles"] {
  const active = {
    maxTokens: values.maxTokens,
    contextTokens: values.contextTokens,
  };
  if (values.modelProvider === "gemma") {
    return { ...values.generationLimitProfiles, gemma: active };
  }
  if (values.modelProvider === "openai-codex") {
    return { ...values.generationLimitProfiles, codex: active };
  }
  return {
    ...values.generationLimitProfiles,
    api: {
      ...values.generationLimitProfiles.api,
      [values.apiProvider]: active,
    },
  };
}

function parseGenerationLimits(profile: GenerationLimitFormValues | undefined) {
  if (!profile) return null;
  const maxTokens = Number(profile.maxTokens);
  const contextTokens = Number(profile.contextTokens);
  return Number.isInteger(maxTokens) && Number.isInteger(contextTokens)
    ? { maxTokens, contextTokens }
    : null;
}

function buildResearchApiProfiles(
  values: SettingsFormValues,
): AppSettings["internetResearch"]["apiProfiles"] {
  const drafts = {
    ...values.researchApiProfiles,
    [values.apiProvider]: {
      model: values.researchApiModel,
      maxOutputTokens: values.researchApiMaxOutputTokens,
      contextTokens: values.researchApiContextTokens,
    },
  };
  const profiles: AppSettings["internetResearch"]["apiProfiles"] = {};
  for (const provider of API_PROVIDER_PRESET_IDS) {
    const parsed = parseResearchApiProfile(drafts[provider]);
    if (parsed) profiles[provider] = parsed;
  }
  return profiles;
}

function parseResearchApiProfile(
  profile: ResearchApiProfileFormValues | undefined,
) {
  if (!profile?.model.trim()) return null;
  const maxOutputTokens = Number(profile.maxOutputTokens);
  const contextTokens = Number(profile.contextTokens);
  return Number.isInteger(maxOutputTokens) && Number.isInteger(contextTokens)
    ? { model: profile.model.trim(), maxOutputTokens, contextTokens }
    : null;
}

function parseOptionalNumber(value: string): number | null {
  return value.trim() ? Number(value) : null;
}

function resolveBlockStyleCollections(
  initialSettings: AppSettings,
  groups: BlockStylePresetGroup[] | undefined,
  presets: BlockStylePreset[] | undefined,
) {
  return {
    blockStylePresetGroups:
      groups ?? initialSettings.blockStylePresetGroups ?? [],
    blockStylePresets: presets ?? initialSettings.blockStylePresets ?? [],
  };
}
