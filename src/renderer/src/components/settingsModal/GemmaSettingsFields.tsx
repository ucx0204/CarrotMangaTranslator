import React from "react";
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
  return (
    <div className="settings-field-stack">
      <span>모델 소스</span>
      <div
        className="settings-mode-group"
        role="tablist"
        aria-label="모델 소스"
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
            {option.label}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {
          MODEL_SOURCE_OPTIONS.find((option) => option.id === modelSource)
            ?.description
        }
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
  return (
    <div className="settings-field-stack">
      <span>모델 / 실행 모드</span>
      <div
        className="settings-preset-group"
        role="tablist"
        aria-label="모델 프리셋"
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
            {presetId === "custom" ? "커스텀" : MODEL_PRESETS[presetId].label}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {selectedPreset === "custom"
          ? "직접 지정한 모델을 사용합니다. 커스텀 모델은 현재 저장된 실행 설정을 유지합니다."
          : MODEL_PRESETS[selectedPreset].description}
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
  return (
    <>
      <label>
        HF repo
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
        GGUF 파일명
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
  return (
    <div className="settings-field-stack">
      <span>Gemma GPU 런타임</span>
      <div
        className="settings-preset-group"
        role="tablist"
        aria-label="Gemma GPU 런타임"
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
            {option.label}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {
          LLAMA_RUNTIME_PROFILE_OPTIONS.find(
            (option) => option.id === llamaRuntimeProfile,
          )?.description
        }
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
  if (usesAmdHardware) {
    return (
      <p className="muted-line modal-note">
        감지된 AMD GPU에서는 CUDA·RTX 런타임이 비활성화되고 ROCm·Vulkan 중에서
        선택합니다.
      </p>
    );
  }
  if (usesNvidiaHardware) {
    return (
      <p className="muted-line modal-note">
        감지된 NVIDIA GPU에서는 ROCm·Vulkan 런타임이 비활성화됩니다.
      </p>
    );
  }
  return null;
}
