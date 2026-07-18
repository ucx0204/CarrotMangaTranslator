import React from "react";
import { useTranslation } from "react-i18next";
import {
  LLAMA_RUNTIME_PROFILE_OPTIONS,
  MODEL_PRESETS,
  MODEL_SOURCE_OPTIONS,
  type ModelPresetId,
} from "../settingsOptions";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";
import { GemmaMemorySummary } from "./GemmaMemorySummary";
import { confirmGemmaMemoryRisk } from "./gemmaMemoryRisk";
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
  | "allowUnsafeUnifiedMemory"
  | "unifiedMemoryMb"
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
  | "setAllowUnsafeUnifiedMemory"
  | "setLocalMmprojPath"
  | "setLocalModelPath"
  | "setModelSource"
  | "setSelectedPreset"
  | "submit"
  | "usesAmdHardware"
  | "usesAppleHardware"
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
  | "allowUnsafeUnifiedMemory"
  | "unifiedMemoryMb"
  | "modelRepoInputRef"
  | "selectedPreset"
  | "setCustomModelFile"
  | "setCustomModelRepo"
  | "setCustomVramMode"
  | "setLlamaRuntimeProfile"
  | "setAllowUnsafeUnifiedMemory"
  | "setSelectedPreset"
  | "submit"
  | "usesAmdHardware"
  | "usesAppleHardware"
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

type ModelPresetSelectorProps = Pick<
  HuggingFaceModelFieldsProps,
  | "clearTestState"
  | "allowUnsafeUnifiedMemory"
  | "controlsBusy"
  | "selectedPreset"
  | "setCustomVramMode"
  | "setAllowUnsafeUnifiedMemory"
  | "setSelectedPreset"
  | "unifiedMemoryMb"
  | "usesAppleHardware"
>;

function ModelPresetSelector({
  allowUnsafeUnifiedMemory,
  clearTestState,
  controlsBusy,
  selectedPreset,
  setCustomVramMode,
  setAllowUnsafeUnifiedMemory,
  setSelectedPreset,
  unifiedMemoryMb,
  usesAppleHardware,
}: ModelPresetSelectorProps): React.JSX.Element {
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
          <ModelPresetButton
            key={presetId}
            presetId={presetId}
            allowUnsafeUnifiedMemory={allowUnsafeUnifiedMemory}
            clearTestState={clearTestState}
            controlsBusy={controlsBusy}
            selectedPreset={selectedPreset}
            setAllowUnsafeUnifiedMemory={setAllowUnsafeUnifiedMemory}
            setCustomVramMode={setCustomVramMode}
            setSelectedPreset={setSelectedPreset}
            unifiedMemoryMb={unifiedMemoryMb}
            usesAppleHardware={usesAppleHardware}
          />
        ))}
      </div>
      <p className="muted-line modal-note">
        {selectedPreset === "custom"
          ? t("settings.gemma.preset.customDescription")
          : t(MODEL_PRESETS[selectedPreset].descriptionKey)}
      </p>
      {usesAppleHardware && selectedPreset !== "custom" ? (
        <GemmaMemorySummary
          allowUnsafeUnifiedMemory={allowUnsafeUnifiedMemory}
          selectedPreset={selectedPreset}
          unifiedMemoryMb={unifiedMemoryMb}
        />
      ) : null}
    </div>
  );
}

function ModelPresetButton({
  presetId,
  ...props
}: ModelPresetSelectorProps & { presetId: ModelPresetId }): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <button
      type="button"
      className={`settings-preset-button ${props.selectedPreset === presetId ? "active" : ""}`}
      disabled={props.controlsBusy}
      aria-pressed={props.selectedPreset === presetId}
      onClick={() => {
        if (!confirmGemmaMemoryRisk(presetId, props, t)) return;
        props.clearTestState();
        props.setSelectedPreset(presetId);
        if (presetId !== "custom") {
          props.setCustomVramMode(MODEL_PRESETS[presetId].vramMode);
        }
      }}
    >
      {presetId === "custom"
        ? t("settings.gemma.preset.custom")
        : t(MODEL_PRESETS[presetId].labelKey)}
    </button>
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
  usesAppleHardware,
  usesNvidiaHardware,
}: Pick<
  HuggingFaceModelFieldsProps,
  | "clearTestState"
  | "isLlamaRuntimeOptionDisabled"
  | "llamaRuntimeProfile"
  | "setLlamaRuntimeProfile"
  | "usesAmdHardware"
  | "usesAppleHardware"
  | "usesNvidiaHardware"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const visibleRuntimeOptions = LLAMA_RUNTIME_PROFILE_OPTIONS.filter(
    (option) =>
      usesAppleHardware ? option.id === "metal" : option.id !== "metal",
  );
  const activeRuntime = visibleRuntimeOptions.find(
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
        {visibleRuntimeOptions.map((option) => (
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
        usesAppleHardware={usesAppleHardware}
        usesNvidiaHardware={usesNvidiaHardware}
      />
    </div>
  );
}

function RuntimeHardwareNote({
  usesAmdHardware,
  usesAppleHardware,
  usesNvidiaHardware,
}: Pick<
  HuggingFaceModelFieldsProps,
  "usesAmdHardware" | "usesAppleHardware" | "usesNvidiaHardware"
>): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (usesAppleHardware) {
    return (
      <p className="muted-line modal-note">
        {t("settings.gemma.runtime.appleNote")}
      </p>
    );
  }
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
