import React from "react";
import type { AppSettings } from "../../../../shared/settingsTypes";
import {
  createSettingsFormValues,
  type SettingsFormValues,
} from "./settingsModalFormUtils";

type FieldSetter<K extends keyof SettingsFormValues> = React.Dispatch<
  React.SetStateAction<SettingsFormValues[K]>
>;

export type SettingsFormSetters = {
  [K in keyof SettingsFormValues as `set${Capitalize<string & K>}`]: FieldSetter<K>;
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
  const refs = {
    modelRepoInputRef: React.useRef<HTMLInputElement | null>(null),
    localModelInputRef: React.useRef<HTMLInputElement | null>(null),
    testLogRef: React.useRef<HTMLDivElement | null>(null),
  };

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
  return {
    setModelProvider: useFormFieldDispatch(setValues, "modelProvider"),
    setSourceLanguage: useFormFieldDispatch(setValues, "sourceLanguage"),
    setTargetLanguage: useFormFieldDispatch(setValues, "targetLanguage"),
    setModelSource: useFormFieldDispatch(setValues, "modelSource"),
    setSelectedPreset: useFormFieldDispatch(setValues, "selectedPreset"),
    setCustomModelRepo: useFormFieldDispatch(setValues, "customModelRepo"),
    setCustomModelFile: useFormFieldDispatch(setValues, "customModelFile"),
    setLocalModelPath: useFormFieldDispatch(setValues, "localModelPath"),
    setLocalMmprojPath: useFormFieldDispatch(setValues, "localMmprojPath"),
    setCustomVramMode: useFormFieldDispatch(setValues, "customVramMode"),
    setLlamaRuntimeProfile: useFormFieldDispatch(
      setValues,
      "llamaRuntimeProfile",
    ),
    setCodexModel: useFormFieldDispatch(setValues, "codexModel"),
    setCodexReasoningEffort: useFormFieldDispatch(
      setValues,
      "codexReasoningEffort",
    ),
    setCodexOauthPort: useFormFieldDispatch(setValues, "codexOauthPort"),
    setApiBaseUrl: useFormFieldDispatch(setValues, "apiBaseUrl"),
    setApiModel: useFormFieldDispatch(setValues, "apiModel"),
    setApiKey: useFormFieldDispatch(setValues, "apiKey"),
    setApiTemperature: useFormFieldDispatch(setValues, "apiTemperature"),
    setApiTopP: useFormFieldDispatch(setValues, "apiTopP"),
    setApiTopK: useFormFieldDispatch(setValues, "apiTopK"),
    setApiReasoningEffort: useFormFieldDispatch(
      setValues,
      "apiReasoningEffort",
    ),
    setApiExtraBodyJson: useFormFieldDispatch(setValues, "apiExtraBodyJson"),
    setApiCustomHeadersJson: useFormFieldDispatch(
      setValues,
      "apiCustomHeadersJson",
    ),
    setOcrDevice: useFormFieldDispatch(setValues, "ocrDevice"),
    setOcrGpuBackend: useFormFieldDispatch(setValues, "ocrGpuBackend"),
    setOcrQualityMode: useFormFieldDispatch(setValues, "ocrQualityMode"),
    setInpaintingModel: useFormFieldDispatch(setValues, "inpaintingModel"),
    setFluxBackend: useFormFieldDispatch(setValues, "fluxBackend"),
    setMaxTokens: useFormFieldDispatch(setValues, "maxTokens"),
    setContextTokens: useFormFieldDispatch(setValues, "contextTokens"),
  };
}

function useFormFieldDispatch<K extends keyof SettingsFormValues>(
  setValues: React.Dispatch<React.SetStateAction<SettingsFormValues>>,
  key: K,
): FieldSetter<K> {
  return React.useCallback(
    (next) => {
      setValues((current) => ({
        ...current,
        [key]:
          typeof next === "function"
            ? (next as (value: SettingsFormValues[K]) => SettingsFormValues[K])(
                current[key],
              )
            : next,
      }));
    },
    [key, setValues],
  );
}
