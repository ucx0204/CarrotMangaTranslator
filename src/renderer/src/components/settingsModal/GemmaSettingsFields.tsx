import React from "react";
import { useTranslation } from "react-i18next";
import {
  LLAMA_RUNTIME_PROFILE_OPTIONS,
  MODEL_PRESETS,
  MODEL_SOURCE_OPTIONS,
  type ModelPresetId,
} from "../settingsOptions";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";
import { LocalModelFields } from "./GemmaLocalModelFields";

const MODEL_PRESET_BUTTON_IDS = [
  "minimum12b",
  "economy26b",
  "full31b",
  "custom",
] as ModelPresetId[];

type GemmaSettingsFieldsProps = Pick<
  EngineSettingsPanelProps,
  | "clearTestState"
  | "controlsBusy"
  | "customModelFile"
  | "customModelRepo"
  | "isLlamaRuntimeOptionDisabled"
  | "llamaRuntimeProfile"
  | "localMmprojPath"
  | "localModelInputRef"
  | "localModelPath"
  | "modelRepoInputRef"
  | "modelSource"
  | "pickLocalMmprojFile"
  | "pickLocalModelFile"
  | "selectedPreset"
  | "setCustomModelFile"
  | "setCustomModelRepo"
  | "setCustomVramMode"
  | "setLlamaRuntimeProfile"
  | "setLocalMmprojPath"
  | "setLocalModelPath"
  | "setModelSource"
  | "setSelectedPreset"
  | "submit"
  | "usesAmdHardware"
  | "usesNvidiaHardware"
>;

export function GemmaSettingsFields(
  props: GemmaSettingsFieldsProps,
): React.JSX.Element {
  return (
    <>
      <ModelSourceSelector {...props} />
      {props.modelSource === "huggingface" ? (
        <HuggingFaceModelFields {...props} />
      ) : (
        <LocalModelFields {...props} />
      )}
    </>
  );
}

function ModelSourceSelector({
  clearTestState,
  controlsBusy,
  modelSource,
  setModelSource,
}: Pick<
  GemmaSettingsFieldsProps,
  "clearTestState" | "controlsBusy" | "modelSource" | "setModelSource"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const activeSource = MODEL_SOURCE_OPTIONS.find(
    (option) => option.id === modelSource,
  );
  return (
    <div className="settings-field-stack">
      <span>{t("settings.gemma.modelSource.label")}</span>
      <div
        className="settings-mode-group"
        role="group"
        aria-label={t("settings.gemma.modelSource.label")}
      >
        {MODEL_SOURCE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`settings-preset-button ${modelSource === option.id ? "active" : ""}`}
            onClick={() => {
              clearTestState();
              setModelSource(option.id);
            }}
            disabled={controlsBusy}
            aria-pressed={modelSource === option.id}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {activeSource ? t(activeSource.descriptionKey) : null}
      </p>
    </div>
  );
}

type HuggingFaceModelFieldsProps = Pick<
  GemmaSettingsFieldsProps,
  | "clearTestState"
  | "controlsBusy"
  | "customModelFile"
  | "customModelRepo"
  | "isLlamaRuntimeOptionDisabled"
  | "llamaRuntimeProfile"
  | "modelRepoInputRef"
  | "selectedPreset"
  | "setCustomModelFile"
  | "setCustomModelRepo"
  | "setCustomVramMode"
  | "setLlamaRuntimeProfile"
  | "setSelectedPreset"
  | "submit"
  | "usesAmdHardware"
  | "usesNvidiaHardware"
>;

function HuggingFaceModelFields(
  props: HuggingFaceModelFieldsProps,
): React.JSX.Element {
  return (
    <>
      <ModelPresetSelector {...props} />
      {props.selectedPreset === "custom" ? (
        <CustomHfModelFields {...props} />
      ) : null}
      <LlamaRuntimeSelector {...props} />
    </>
  );
}

function ModelPresetSelector({
  clearTestState,
  controlsBusy,
  selectedPreset,
  setCustomVramMode,
  setSelectedPreset,
}: Pick<
  HuggingFaceModelFieldsProps,
  | "clearTestState"
  | "controlsBusy"
  | "selectedPreset"
  | "setCustomVramMode"
  | "setSelectedPreset"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-field-stack">
      <span>{t("settings.gemma.preset.label")}</span>
      <div
        className="settings-preset-group"
        role="group"
        aria-label={t("settings.gemma.preset.ariaLabel")}
      >
        {MODEL_PRESET_BUTTON_IDS.map((presetId) => (
          <button
            key={presetId}
            type="button"
            className={`settings-preset-button ${selectedPreset === presetId ? "active" : ""}`}
            onClick={() => {
              clearTestState();
              setSelectedPreset(presetId);
              if (presetId !== "custom") {
                setCustomVramMode(MODEL_PRESETS[presetId].vramMode);
              }
            }}
            disabled={controlsBusy}
            aria-pressed={selectedPreset === presetId}
          >
            {presetId === "custom"
              ? t("settings.gemma.preset.custom")
              : t(MODEL_PRESETS[presetId].labelKey)}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {selectedPreset === "custom"
          ? t("settings.gemma.preset.customDescription")
          : t(MODEL_PRESETS[selectedPreset].descriptionKey)}
      </p>
    </div>
  );
}

function CustomHfModelFields({
  clearTestState,
  controlsBusy,
  customModelFile,
  customModelRepo,
  modelRepoInputRef,
  setCustomModelFile,
  setCustomModelRepo,
  submit,
}: Pick<
  HuggingFaceModelFieldsProps,
  | "clearTestState"
  | "controlsBusy"
  | "customModelFile"
  | "customModelRepo"
  | "modelRepoInputRef"
  | "setCustomModelFile"
  | "setCustomModelRepo"
  | "submit"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <label>
        {t("settings.gemma.hfRepo")}
        <input
          ref={modelRepoInputRef}
          value={customModelRepo}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setCustomModelRepo(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            }
          }}
        />
      </label>
      <label>
        {t("settings.gemma.ggufFile")}
        <input
          value={customModelFile}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setCustomModelFile(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            }
          }}
        />
      </label>
    </>
  );
}

function LlamaRuntimeSelector({
  clearTestState,
  isLlamaRuntimeOptionDisabled,
  llamaRuntimeProfile,
  setLlamaRuntimeProfile,
  usesAmdHardware,
  usesNvidiaHardware,
}: Pick<
  HuggingFaceModelFieldsProps,
  | "clearTestState"
  | "isLlamaRuntimeOptionDisabled"
  | "llamaRuntimeProfile"
  | "setLlamaRuntimeProfile"
  | "usesAmdHardware"
  | "usesNvidiaHardware"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const activeRuntime = LLAMA_RUNTIME_PROFILE_OPTIONS.find(
    (option) => option.id === llamaRuntimeProfile,
  );
  return (
    <div className="settings-field-stack">
      <span>{t("settings.gemma.runtime.label")}</span>
      <div
        className="settings-preset-group"
        role="group"
        aria-label={t("settings.gemma.runtime.label")}
      >
        {LLAMA_RUNTIME_PROFILE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`settings-preset-button ${llamaRuntimeProfile === option.id ? "active" : ""}`}
            onClick={() => {
              clearTestState();
              setLlamaRuntimeProfile(option.id);
            }}
            disabled={isLlamaRuntimeOptionDisabled(option.id)}
            aria-pressed={llamaRuntimeProfile === option.id}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {activeRuntime ? t(activeRuntime.descriptionKey) : null}
      </p>
      <RuntimeHardwareNote
        usesAmdHardware={usesAmdHardware}
        usesNvidiaHardware={usesNvidiaHardware}
      />
    </div>
  );
}

function RuntimeHardwareNote({
  usesAmdHardware,
  usesNvidiaHardware,
}: Pick<
  HuggingFaceModelFieldsProps,
  "usesAmdHardware" | "usesNvidiaHardware"
>): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (usesAmdHardware) {
    return (
      <p className="muted-line modal-note">
        {t("settings.gemma.runtime.amdNote")}
      </p>
    );
  }
  if (usesNvidiaHardware) {
    return (
      <p className="muted-line modal-note">
        {t("settings.gemma.runtime.nvidiaNote")}
      </p>
    );
  }
  return null;
}
