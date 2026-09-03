import React from "react";
import type { AppSettings } from "../../../../shared/settingsTypes";
import {
  createSettingsFormValues,
  type SettingsFormValues,
} from "./settingsModalFormValues";
import {
  createDefaultApiProfileFormValues,
  createDefaultGenerationLimitFormValues,
  createDefaultResearchApiProfileFormValues,
  type ApiProfileFormValues,
} from "./settingsModalProfileFormValues";
import type { ApiProviderPresetId } from "../../../../shared/apiProviderPresets";
import type { ModelProvider } from "../../../../shared/settingsTypes";

type FieldSetter<K extends keyof SettingsFormValues> = React.Dispatch<
  React.SetStateAction<SettingsFormValues[K]>
>;

type MutableSettingsFormField = Exclude<
  keyof SettingsFormValues,
  | "apiKeyCount"
  | "apiProfiles"
  | "apiProvider"
  | "generationLimitProfiles"
  | "modelProvider"
  | "researchApiProfiles"
>;

export type SettingsFormSetters = {
  [K in MutableSettingsFormField as `set${Capitalize<string & K>}`]: FieldSetter<K>;
} & {
  setApiProvider: FieldSetter<"apiProvider">;
  setModelProvider: FieldSetter<"modelProvider">;
};

export type SettingsFormRefs = {
  localModelInputRef: React.RefObject<HTMLInputElement | null>;
  modelRepoInputRef: React.RefObject<HTMLInputElement | null>;
  testLogRef: React.RefObject<HTMLDivElement | null>;
};

export type SettingsFormState = {
  values: SettingsFormValues;
  setValues: React.Dispatch<React.SetStateAction<SettingsFormValues>>;
  setters: SettingsFormSetters;
  refs: SettingsFormRefs;
};

export function useSettingsFormState(
  initialSettings: AppSettings,
): SettingsFormState {
  const [values, setValues] = React.useState(() =>
    createSettingsFormValues(initialSettings),
  );
  const modelRepoInputRef = React.useRef<HTMLInputElement | null>(null);
  const localModelInputRef = React.useRef<HTMLInputElement | null>(null);
  const testLogRef = React.useRef<HTMLDivElement | null>(null);
  const refs = React.useMemo(
    () => ({ modelRepoInputRef, localModelInputRef, testLogRef }),
    [],
  );

  React.useEffect(() => {
    setValues(createSettingsFormValues(initialSettings));
  }, [initialSettings]);

  return {
    values,
    setValues,
    setters: useSettingsFormSetters(setValues),
    refs,
  };
}

function useSettingsFormSetters(
  setValues: React.Dispatch<React.SetStateAction<SettingsFormValues>>,
): SettingsFormSetters {
  return React.useMemo(
    () => ({
      setUiLocale: createFormFieldDispatch(setValues, "uiLocale"),
      setWheelZoomSensitivityPercent: createFormFieldDispatch(
        setValues,
        "wheelZoomSensitivityPercent",
      ),
      setModelProvider: createModelProviderDispatch(setValues),
      setSourceLanguage: createFormFieldDispatch(setValues, "sourceLanguage"),
      setTargetLanguage: createFormFieldDispatch(setValues, "targetLanguage"),
      setModelSource: createFormFieldDispatch(setValues, "modelSource"),
      setSelectedPreset: createFormFieldDispatch(setValues, "selectedPreset"),
      setCustomModelRepo: createFormFieldDispatch(setValues, "customModelRepo"),
      setCustomModelFile: createFormFieldDispatch(setValues, "customModelFile"),
      setLocalModelPath: createFormFieldDispatch(setValues, "localModelPath"),
      setLocalMmprojPath: createFormFieldDispatch(setValues, "localMmprojPath"),
      setCustomVramMode: createFormFieldDispatch(setValues, "customVramMode"),
      setGemmaFitTargetMb: createFormFieldDispatch(
        setValues,
        "gemmaFitTargetMb",
      ),
      setGemmaMmprojOffload: createFormFieldDispatch(
        setValues,
        "gemmaMmprojOffload",
      ),
      setLlamaRuntimeProfile: createFormFieldDispatch(
        setValues,
        "llamaRuntimeProfile",
      ),
      setAllowUnsafeUnifiedMemory: createFormFieldDispatch(
        setValues,
        "allowUnsafeUnifiedMemory",
      ),
      setCodexModel: createFormFieldDispatch(setValues, "codexModel"),
      setCodexReasoningEffort: createFormFieldDispatch(
        setValues,
        "codexReasoningEffort",
      ),
      ...createResearchFormSetters(setValues),
      ...createApiFormSetters(setValues),
      setGraphicsGpuPreference: createFormFieldDispatch(
        setValues,
        "graphicsGpuPreference",
      ),
      setComputeGpuIndex: createFormFieldDispatch(setValues, "computeGpuIndex"),
      setOcrDevice: createFormFieldDispatch(setValues, "ocrDevice"),
      setOcrPipeline: createFormFieldDispatch(setValues, "ocrPipeline"),
      setOcrGpuBackend: createFormFieldDispatch(setValues, "ocrGpuBackend"),
      setOcrQualityMode: createFormFieldDispatch(setValues, "ocrQualityMode"),
      setInpaintingModel: createFormFieldDispatch(setValues, "inpaintingModel"),
      setFluxBackend: createFormFieldDispatch(setValues, "fluxBackend"),
      setAllowUnsafeLowMemoryFlux: createFormFieldDispatch(
        setValues,
        "allowUnsafeLowMemoryFlux",
      ),
      setBubbleLayoutPaddingRatio: createFormFieldDispatch(
        setValues,
        "bubbleLayoutPaddingRatio",
      ),
      setMaxTokens: createFormFieldDispatch(setValues, "maxTokens"),
      setContextTokens: createFormFieldDispatch(setValues, "contextTokens"),
    }),
    [setValues],
  );
}

function createResearchFormSetters(
  setValues: React.Dispatch<React.SetStateAction<SettingsFormValues>>,
) {
  return {
    setResearchTavilyAnalysisProvider: createFormFieldDispatch(
      setValues,
      "researchTavilyAnalysisProvider",
    ),
    setResearchGemmaPreset: createFormFieldDispatch(
      setValues,
      "researchGemmaPreset",
    ),
    setResearchGemmaReasoningEffort: createFormFieldDispatch(
      setValues,
      "researchGemmaReasoningEffort",
    ),
    setResearchGemmaMaxOutputTokens: createFormFieldDispatch(
      setValues,
      "researchGemmaMaxOutputTokens",
    ),
    setResearchGemmaContextTokens: createFormFieldDispatch(
      setValues,
      "researchGemmaContextTokens",
    ),
    setResearchApiModel: createFormFieldDispatch(setValues, "researchApiModel"),
    setResearchApiMaxOutputTokens: createFormFieldDispatch(
      setValues,
      "researchApiMaxOutputTokens",
    ),
    setResearchApiContextTokens: createFormFieldDispatch(
      setValues,
      "researchApiContextTokens",
    ),
    setResearchCodexModel: createFormFieldDispatch(
      setValues,
      "researchCodexModel",
    ),
    setResearchCodexReasoningEffort: createFormFieldDispatch(
      setValues,
      "researchCodexReasoningEffort",
    ),
    setResearchCodexMaxOutputTokens: createFormFieldDispatch(
      setValues,
      "researchCodexMaxOutputTokens",
    ),
    setResearchCodexContextTokens: createFormFieldDispatch(
      setValues,
      "researchCodexContextTokens",
    ),
    setTavilyApiKey: createFormFieldDispatch(setValues, "tavilyApiKey"),
    setTavilyMaxCreditsPerRun: createFormFieldDispatch(
      setValues,
      "tavilyMaxCreditsPerRun",
    ),
  };
}

function createApiFormSetters(
  setValues: React.Dispatch<React.SetStateAction<SettingsFormValues>>,
) {
  return {
    setApiProvider: createApiProviderDispatch(setValues),
    setApiBaseUrl: createFormFieldDispatch(setValues, "apiBaseUrl"),
    setApiModel: createFormFieldDispatch(setValues, "apiModel"),
    setApiKey: createFormFieldDispatch(setValues, "apiKey"),
    setApiVertexAuthMode: createFormFieldDispatch(
      setValues,
      "apiVertexAuthMode",
    ),
    setApiVertexServiceAccountPath: createFormFieldDispatch(
      setValues,
      "apiVertexServiceAccountPath",
    ),
    setApiKeyMaxAttempts: createFormFieldDispatch(
      setValues,
      "apiKeyMaxAttempts",
    ),
    setApiRetryDelaySeconds: createFormFieldDispatch(
      setValues,
      "apiRetryDelaySeconds",
    ),
    setApiTemperature: createFormFieldDispatch(setValues, "apiTemperature"),
    setApiTopP: createFormFieldDispatch(setValues, "apiTopP"),
    setApiTopK: createFormFieldDispatch(setValues, "apiTopK"),
    setApiReasoningEffort: createFormFieldDispatch(
      setValues,
      "apiReasoningEffort",
    ),
    setApiExtraBodyJson: createFormFieldDispatch(setValues, "apiExtraBodyJson"),
    setApiCustomHeadersJson: createFormFieldDispatch(
      setValues,
      "apiCustomHeadersJson",
    ),
  };
}

function createModelProviderDispatch(
  setValues: React.Dispatch<React.SetStateAction<SettingsFormValues>>,
): FieldSetter<"modelProvider"> {
  return (next) => {
    setValues((current) => {
      const provider = resolveStateAction(next, current.modelProvider);
      if (provider === current.modelProvider) return current;
      const generationLimitProfiles = snapshotActiveGenerationLimits(current);
      const limits = resolveGenerationLimitsForProvider(
        generationLimitProfiles,
        provider,
        current.apiProvider,
        current,
      );
      return {
        ...current,
        modelProvider: provider,
        generationLimitProfiles,
        maxTokens: limits.maxTokens,
        contextTokens: limits.contextTokens,
      };
    });
  };
}

function createApiProviderDispatch(
  setValues: React.Dispatch<React.SetStateAction<SettingsFormValues>>,
): FieldSetter<"apiProvider"> {
  return (next) => {
    setValues((current) => {
      const provider = resolveStateAction(next, current.apiProvider);
      if (provider === current.apiProvider) return current;
      const apiProfiles = {
        ...current.apiProfiles,
        [current.apiProvider]: readActiveApiProfile(current),
      };
      const researchApiProfiles = {
        ...current.researchApiProfiles,
        [current.apiProvider]: {
          model: current.researchApiModel,
          maxOutputTokens: current.researchApiMaxOutputTokens,
          contextTokens: current.researchApiContextTokens,
        },
      };
      const generationLimitProfiles = snapshotActiveGenerationLimits(current);
      const apiProfile =
        apiProfiles[provider] ?? createDefaultApiProfileFormValues(provider);
      const researchProfile =
        researchApiProfiles[provider] ??
        createDefaultResearchApiProfileFormValues(apiProfile.apiModel);
      const apiLimits =
        generationLimitProfiles.api[provider] ??
        createDefaultGenerationLimitFormValues(
          "openai-api",
          apiProfile.apiModel,
        );
      return {
        ...current,
        ...apiProfile,
        apiProvider: provider,
        apiProfiles,
        generationLimitProfiles,
        researchApiModel: researchProfile.model,
        researchApiMaxOutputTokens: researchProfile.maxOutputTokens,
        researchApiContextTokens: researchProfile.contextTokens,
        researchApiProfiles,
        ...(current.modelProvider === "openai-api"
          ? {
              maxTokens: apiLimits.maxTokens,
              contextTokens: apiLimits.contextTokens,
            }
          : {}),
      };
    });
  };
}

function snapshotActiveGenerationLimits(
  current: SettingsFormValues,
): SettingsFormValues["generationLimitProfiles"] {
  const limits = {
    maxTokens: current.maxTokens,
    contextTokens: current.contextTokens,
  };
  if (current.modelProvider === "gemma") {
    return { ...current.generationLimitProfiles, gemma: limits };
  }
  if (current.modelProvider === "openai-codex") {
    return { ...current.generationLimitProfiles, codex: limits };
  }
  return {
    ...current.generationLimitProfiles,
    api: {
      ...current.generationLimitProfiles.api,
      [current.apiProvider]: limits,
    },
  };
}

function resolveGenerationLimitsForProvider(
  profiles: SettingsFormValues["generationLimitProfiles"],
  provider: ModelProvider,
  apiProvider: ApiProviderPresetId,
  current: SettingsFormValues,
) {
  if (provider === "gemma") return profiles.gemma;
  if (provider === "openai-codex") return profiles.codex;
  return (
    profiles.api[apiProvider] ??
    createDefaultGenerationLimitFormValues("openai-api", current.apiModel)
  );
}

function readActiveApiProfile(
  values: SettingsFormValues,
): ApiProfileFormValues {
  return {
    apiBaseUrl: values.apiBaseUrl,
    apiModel: values.apiModel,
    apiKey: values.apiKey,
    apiKeyCount: values.apiKeyCount,
    apiVertexAuthMode: values.apiVertexAuthMode,
    apiVertexServiceAccountPath: values.apiVertexServiceAccountPath,
    apiKeyMaxAttempts: values.apiKeyMaxAttempts,
    apiRetryDelaySeconds: values.apiRetryDelaySeconds,
    apiTemperature: values.apiTemperature,
    apiTopP: values.apiTopP,
    apiTopK: values.apiTopK,
    apiReasoningEffort: values.apiReasoningEffort,
    apiExtraBodyJson: values.apiExtraBodyJson,
    apiCustomHeadersJson: values.apiCustomHeadersJson,
  };
}

function resolveStateAction<T>(action: React.SetStateAction<T>, current: T): T {
  return typeof action === "function"
    ? (action as (value: T) => T)(current)
    : action;
}

function createFormFieldDispatch<K extends keyof SettingsFormValues>(
  setValues: React.Dispatch<React.SetStateAction<SettingsFormValues>>,
  key: K,
): FieldSetter<K> {
  return (next) => {
    setValues((current) => ({
      ...current,
      [key]:
        typeof next === "function"
          ? (next as (value: SettingsFormValues[K]) => SettingsFormValues[K])(
              current[key],
            )
          : next,
    }));
  };
}
