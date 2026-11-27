import { GemmaSamplingFields } from "./GemmaSamplingFields";
import React from "react";
import { ControlTooltip } from "../ui/ControlTooltip";
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
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";

type GemmaSettingsFieldsProps = Pick<
  EngineSettingsPanelProps,
  | "clearTestState"
  | "controlsBusy"
  | "customModelFile"
  | "customModelRepo"
  | "detectedGpuName"
  | "gemmaSampling"
  | "setGemmaSampling"
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
  | "intel"
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
      {props.llamaRuntimeProfile !== "cpu" && (
        <GemmaVramTuningFields {...props} />
      )}
      <GemmaSamplingFields {...props} />
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
  return (
    <div className="settings-field-stack">
      <span>{t("settings.gemma.modelSource.label")}</span>
      <div
        className="settings-mode-group"
        role="group"
        aria-label={t("settings.gemma.modelSource.label")}
      >
        {MODEL_SOURCE_OPTIONS.map((option) => (
          <ControlTooltip
            floating
            content={t(option.descriptionKey)}
            key={option.id}
          >
            <Button
              key={option.id}
              type="button"
              className={`settings-preset-button ${modelSource === option.id ? "active" : ""}`}
              onClick={() => {
                clearTestState();
                setModelSource(option.id);
              }}
              disabled={controlsBusy}
              aria-pressed={modelSource === option.id}
              variant="bare"
            >
              {t(option.labelKey)}
            </Button>
          </ControlTooltip>
        ))}
      </div>
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
  | "setGemmaMmprojOffload"
  | "setAllowUnsafeUnifiedMemory"
  | "setSelectedPreset"
  | "submit"
  | "intel"
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
        <Input
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
        <Input
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
  intel,
  usesNvidiaHardware,
  usesRtx50Hardware,
}: Pick<
  HuggingFaceModelFieldsProps,
  | "clearTestState"
  | "detectedGpuName"
  | "isLlamaRuntimeOptionDisabled"
  | "llamaRuntimeProfile"
  | "setLlamaRuntimeProfile"
  | "intel"
  | "usesAppleHardware"
  | "usesNvidiaHardware"
  | "usesRtx50Hardware"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const visibleRuntimeOptions = LLAMA_RUNTIME_PROFILE_OPTIONS.filter(
    (option) =>
      intel
        ? option.id === "cpu" || (intel.vulkan && option.id === "vulkan")
        : usesAppleHardware
          ? option.id === "metal"
          : option.id !== "metal" && option.id !== "cpu",
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
          <ControlTooltip
            floating
            content={t(option.descriptionKey)}
            key={option.id}
          >
            <Button
              key={option.id}
              type="button"
              className={`settings-preset-button ${llamaRuntimeProfile === option.id ? "active" : ""}`}
              onClick={() => {
                clearTestState();
                setLlamaRuntimeProfile(option.id);
              }}
              disabled={isLlamaRuntimeOptionDisabled(option.id)}
              aria-pressed={llamaRuntimeProfile === option.id}
              variant="bare"
            >
              {t(option.labelKey)}
            </Button>
          </ControlTooltip>
        ))}
      </div>

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
