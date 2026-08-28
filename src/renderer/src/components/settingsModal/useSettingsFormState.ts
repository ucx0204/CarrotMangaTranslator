import React from "react";
import type { AppSettings } from "../../../../shared/settingsTypes";
import {
  createSettingsFormValues,
  type SettingsFormValues,
} from "./settingsModalFormValues";

type FieldSetter<K extends keyof SettingsFormValues> = React.Dispatch<
  React.SetStateAction<SettingsFormValues[K]>
>;

type MutableSettingsFormField = Exclude<
  keyof SettingsFormValues,
  "apiKeyCount"
>;

export type SettingsFormSetters = {
  [K in MutableSettingsFormField as `set${Capitalize<string & K>}`]: FieldSetter<K>;
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
      setModelProvider: createFormFieldDispatch(setValues, "modelProvider"),
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
