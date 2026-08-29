import React from "react";
import { useTranslation } from "react-i18next";
import {
  LLAMA_RUNTIME_PROFILE_OPTIONS,
  MODEL_SOURCE_OPTIONS,
} from "../settingsOptions";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";
import {
  GemmaVramTuningFields,
  RuntimeHardwareNote,
} from "./GemmaMemorySummary";
import { GemmaModelPresetSelector } from "./GemmaModelPresetSelector";
import { LocalModelFields } from "./GemmaLocalModelFields";
import { LlamaRuntimeCompatibilityWarning } from "./LlamaRuntimeCompatibilityWarning";

type GemmaSettingsFieldsProps = Pick<
  EngineSettingsPanelProps,
  | "clearTestState"
  | "controlsBusy"
  | "customModelFile"
  | "customModelRepo"
  | "detectedGpuName"
  | "gemmaFitTargetMb"
  | "gemmaMmprojOffload"
  | "gpuMemoryMb"
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
  | "setGemmaFitTargetMb"
  | "setGemmaMmprojOffload"
  | "setLlamaRuntimeProfile"
  | "setAllowUnsafeUnifiedMemory"
  | "setLocalMmprojPath"
  | "setLocalModelPath"
  | "setModelSource"
  | "setSelectedPreset"
  | "submit"
  | "usesAppleHardware"
  | "usesNvidiaHardware"
  | "usesRtx50Hardware"
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
      <GemmaVramTuningFields {...props} />
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
  | "detectedGpuName"
  | "gpuMemoryMb"
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
  | "usesAppleHardware"
  | "usesNvidiaHardware"
  | "usesRtx50Hardware"
>;

function HuggingFaceModelFields(
  props: HuggingFaceModelFieldsProps,
): React.JSX.Element {
  return (
    <>
      <GemmaModelPresetSelector {...props} />
      {props.selectedPreset === "custom" ? (
        <CustomHfModelFields {...props} />
      ) : null}
      <LlamaRuntimeSelector {...props} />
    </>
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
  detectedGpuName,
  isLlamaRuntimeOptionDisabled,
  llamaRuntimeProfile,
  setLlamaRuntimeProfile,
  usesAppleHardware,
  usesNvidiaHardware,
  usesRtx50Hardware,
}: Pick<
  HuggingFaceModelFieldsProps,
  | "clearTestState"
  | "detectedGpuName"
  | "isLlamaRuntimeOptionDisabled"
  | "llamaRuntimeProfile"
  | "setLlamaRuntimeProfile"
  | "usesAppleHardware"
  | "usesNvidiaHardware"
  | "usesRtx50Hardware"
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
      <LlamaRuntimeCompatibilityWarning
        detectedGpuName={detectedGpuName}
        llamaRuntimeProfile={llamaRuntimeProfile}
        usesNvidiaHardware={usesNvidiaHardware}
        usesRtx50Hardware={usesRtx50Hardware}
      />
      <RuntimeHardwareNote usesAppleHardware={usesAppleHardware} />
    </div>
  );
}
