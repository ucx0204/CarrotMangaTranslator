import React from "react";
import type {
  CodexReasoningEffort,
  GemmaVramMode,
  LlamaRuntimeProfile,
  ModelProvider,
  ModelSource,
} from "../../../../shared/types";
import {
  CODEX_REASONING_OPTIONS,
  LLAMA_RUNTIME_PROFILE_OPTIONS,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  MODEL_PRESETS,
  MODEL_PROVIDER_OPTIONS,
  MODEL_SOURCE_OPTIONS,
  type ModelPresetId,
} from "../settingsOptions";

const MODEL_PRESET_BUTTON_IDS = [
  ...Object.keys(MODEL_PRESETS),
  "custom",
] as ModelPresetId[];

type EngineSettingsPanelProps = {
  clearTestState: () => void;
  codexModel: string;
  codexOauthPort: string;
  codexReasoningEffort: CodexReasoningEffort;
  controlsBusy: boolean;
  customModelFile: string;
  customModelRepo: string;
  isLlamaRuntimeOptionDisabled: (profile: LlamaRuntimeProfile) => boolean;
  llamaRuntimeProfile: LlamaRuntimeProfile;
  localMmprojPath: string;
  localModelInputRef: React.RefObject<HTMLInputElement | null>;
  localModelPath: string;
  maxTokens: string;
  modelProvider: ModelProvider;
  modelRepoInputRef: React.RefObject<HTMLInputElement | null>;
  modelSource: ModelSource;
  pickLocalMmprojFile: () => Promise<void>;
  pickLocalModelFile: () => Promise<void>;
  selectedPreset: ModelPresetId;
  setCodexModel: React.Dispatch<React.SetStateAction<string>>;
  setCodexOauthPort: React.Dispatch<React.SetStateAction<string>>;
  setCodexReasoningEffort: React.Dispatch<
    React.SetStateAction<CodexReasoningEffort>
  >;
  setCustomModelFile: React.Dispatch<React.SetStateAction<string>>;
  setCustomModelRepo: React.Dispatch<React.SetStateAction<string>>;
  setCustomVramMode: React.Dispatch<React.SetStateAction<GemmaVramMode>>;
  setLlamaRuntimeProfile: React.Dispatch<
    React.SetStateAction<LlamaRuntimeProfile>
  >;
  setLocalMmprojPath: React.Dispatch<React.SetStateAction<string>>;
  setLocalModelPath: React.Dispatch<React.SetStateAction<string>>;
  setMaxTokens: React.Dispatch<React.SetStateAction<string>>;
  setModelProvider: React.Dispatch<React.SetStateAction<ModelProvider>>;
  setModelSource: React.Dispatch<React.SetStateAction<ModelSource>>;
  setSelectedPreset: React.Dispatch<React.SetStateAction<ModelPresetId>>;
  submit: () => void;
  usesAmdHardware: boolean;
  usesNvidiaHardware: boolean;
};

export function EngineSettingsPanel({
  clearTestState,
  codexModel,
  codexOauthPort,
  codexReasoningEffort,
  controlsBusy,
  customModelFile,
  customModelRepo,
  isLlamaRuntimeOptionDisabled,
  llamaRuntimeProfile,
  localMmprojPath,
  localModelInputRef,
  localModelPath,
  maxTokens,
  modelProvider,
  modelRepoInputRef,
  modelSource,
  pickLocalMmprojFile,
  pickLocalModelFile,
  selectedPreset,
  setCodexModel,
  setCodexOauthPort,
  setCodexReasoningEffort,
  setCustomModelFile,
  setCustomModelRepo,
  setCustomVramMode,
  setLlamaRuntimeProfile,
  setLocalMmprojPath,
  setLocalModelPath,
  setMaxTokens,
  setModelProvider,
  setModelSource,
  setSelectedPreset,
  submit,
  usesAmdHardware,
  usesNvidiaHardware,
}: EngineSettingsPanelProps): React.JSX.Element {
  return (
    <>
      <TranslationEngineSelector
        clearTestState={clearTestState}
        controlsBusy={controlsBusy}
        modelProvider={modelProvider}
        setModelProvider={setModelProvider}
      />
      <MaxTokensField
        clearTestState={clearTestState}
        controlsBusy={controlsBusy}
        maxTokens={maxTokens}
        setMaxTokens={setMaxTokens}
        submit={submit}
      />

      {modelProvider === "gemma" ? (
        <GemmaSettingsFields
          clearTestState={clearTestState}
          controlsBusy={controlsBusy}
          customModelFile={customModelFile}
          customModelRepo={customModelRepo}
          isLlamaRuntimeOptionDisabled={isLlamaRuntimeOptionDisabled}
          llamaRuntimeProfile={llamaRuntimeProfile}
          localMmprojPath={localMmprojPath}
          localModelInputRef={localModelInputRef}
          localModelPath={localModelPath}
          modelRepoInputRef={modelRepoInputRef}
          modelSource={modelSource}
          pickLocalMmprojFile={pickLocalMmprojFile}
          pickLocalModelFile={pickLocalModelFile}
          selectedPreset={selectedPreset}
          setCustomModelFile={setCustomModelFile}
          setCustomModelRepo={setCustomModelRepo}
          setCustomVramMode={setCustomVramMode}
          setLlamaRuntimeProfile={setLlamaRuntimeProfile}
          setLocalMmprojPath={setLocalMmprojPath}
          setLocalModelPath={setLocalModelPath}
          setModelSource={setModelSource}
          setSelectedPreset={setSelectedPreset}
          submit={submit}
          usesAmdHardware={usesAmdHardware}
          usesNvidiaHardware={usesNvidiaHardware}
        />
      ) : (
        <CodexSettingsFields
          clearTestState={clearTestState}
          codexModel={codexModel}
          codexOauthPort={codexOauthPort}
          codexReasoningEffort={codexReasoningEffort}
          controlsBusy={controlsBusy}
          setCodexModel={setCodexModel}
          setCodexOauthPort={setCodexOauthPort}
          setCodexReasoningEffort={setCodexReasoningEffort}
          submit={submit}
        />
      )}
    </>
  );
}

type TranslationEngineSelectorProps = Pick<
  EngineSettingsPanelProps,
  "clearTestState" | "controlsBusy" | "modelProvider" | "setModelProvider"
>;

function TranslationEngineSelector({
  clearTestState,
  controlsBusy,
  modelProvider,
  setModelProvider,
}: TranslationEngineSelectorProps): React.JSX.Element {
  return (
    <div className="settings-field-stack">
      <span>번역 엔진</span>
      <div
        className="settings-mode-group"
        role="tablist"
        aria-label="번역 엔진"
      >
        {MODEL_PROVIDER_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`settings-preset-button ${modelProvider === option.id ? "active" : ""}`}
            onClick={() => {
              clearTestState();
              setModelProvider(option.id);
            }}
            disabled={controlsBusy}
            aria-pressed={modelProvider === option.id}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {
          MODEL_PROVIDER_OPTIONS.find((option) => option.id === modelProvider)
            ?.description
        }
      </p>
    </div>
  );
}

type MaxTokensFieldProps = Pick<
  EngineSettingsPanelProps,
  "clearTestState" | "controlsBusy" | "maxTokens" | "setMaxTokens" | "submit"
>;

function MaxTokensField({
  clearTestState,
  controlsBusy,
  maxTokens,
  setMaxTokens,
  submit,
}: MaxTokensFieldProps): React.JSX.Element {
  return (
    <>
      <label>
        최대 출력 토큰
        <input
          type="number"
          min={MIN_MAX_TOKENS}
          max={MAX_MAX_TOKENS}
          step={100}
          value={maxTokens}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setMaxTokens(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            }
          }}
        />
      </label>
      <p className="muted-line modal-note">
        출력이 길어지는 페이지에서 말풍선 누락을 줄입니다. 기본값은 12000입니다.
      </p>
    </>
  );
}

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

function GemmaSettingsFields({
  clearTestState,
  controlsBusy,
  customModelFile,
  customModelRepo,
  isLlamaRuntimeOptionDisabled,
  llamaRuntimeProfile,
  localMmprojPath,
  localModelInputRef,
  localModelPath,
  modelRepoInputRef,
  modelSource,
  pickLocalMmprojFile,
  pickLocalModelFile,
  selectedPreset,
  setCustomModelFile,
  setCustomModelRepo,
  setCustomVramMode,
  setLlamaRuntimeProfile,
  setLocalMmprojPath,
  setLocalModelPath,
  setModelSource,
  setSelectedPreset,
  submit,
  usesAmdHardware,
  usesNvidiaHardware,
}: GemmaSettingsFieldsProps): React.JSX.Element {
  return (
    <>
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

      {modelSource === "huggingface" ? (
        <HuggingFaceModelFields
          clearTestState={clearTestState}
          controlsBusy={controlsBusy}
          customModelFile={customModelFile}
          customModelRepo={customModelRepo}
          isLlamaRuntimeOptionDisabled={isLlamaRuntimeOptionDisabled}
          llamaRuntimeProfile={llamaRuntimeProfile}
          modelRepoInputRef={modelRepoInputRef}
          selectedPreset={selectedPreset}
          setCustomModelFile={setCustomModelFile}
          setCustomModelRepo={setCustomModelRepo}
          setCustomVramMode={setCustomVramMode}
          setLlamaRuntimeProfile={setLlamaRuntimeProfile}
          setSelectedPreset={setSelectedPreset}
          submit={submit}
          usesAmdHardware={usesAmdHardware}
          usesNvidiaHardware={usesNvidiaHardware}
        />
      ) : (
        <LocalModelFields
          clearTestState={clearTestState}
          controlsBusy={controlsBusy}
          localMmprojPath={localMmprojPath}
          localModelInputRef={localModelInputRef}
          localModelPath={localModelPath}
          pickLocalMmprojFile={pickLocalMmprojFile}
          pickLocalModelFile={pickLocalModelFile}
          setLocalMmprojPath={setLocalMmprojPath}
          setLocalModelPath={setLocalModelPath}
          submit={submit}
        />
      )}
    </>
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

function HuggingFaceModelFields({
  clearTestState,
  controlsBusy,
  customModelFile,
  customModelRepo,
  isLlamaRuntimeOptionDisabled,
  llamaRuntimeProfile,
  modelRepoInputRef,
  selectedPreset,
  setCustomModelFile,
  setCustomModelRepo,
  setCustomVramMode,
  setLlamaRuntimeProfile,
  setSelectedPreset,
  submit,
  usesAmdHardware,
  usesNvidiaHardware,
}: HuggingFaceModelFieldsProps): React.JSX.Element {
  return (
    <>
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
      {selectedPreset === "custom" ? (
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
      ) : null}
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
        {usesAmdHardware ? (
          <p className="muted-line modal-note">
            감지된 AMD GPU에서는 CUDA·RTX 런타임이 비활성화되고 ROCm·Vulkan
            중에서 선택합니다.
          </p>
        ) : usesNvidiaHardware ? (
          <p className="muted-line modal-note">
            감지된 NVIDIA GPU에서는 ROCm·Vulkan 런타임이 비활성화됩니다.
          </p>
        ) : null}
      </div>
    </>
  );
}

type LocalModelFieldsProps = Pick<
  GemmaSettingsFieldsProps,
  | "clearTestState"
  | "controlsBusy"
  | "localMmprojPath"
  | "localModelInputRef"
  | "localModelPath"
  | "pickLocalMmprojFile"
  | "pickLocalModelFile"
  | "setLocalMmprojPath"
  | "setLocalModelPath"
  | "submit"
>;

function LocalModelFields({
  clearTestState,
  controlsBusy,
  localMmprojPath,
  localModelInputRef,
  localModelPath,
  pickLocalMmprojFile,
  pickLocalModelFile,
  setLocalMmprojPath,
  setLocalModelPath,
  submit,
}: LocalModelFieldsProps): React.JSX.Element {
  return (
    <>
      <div className="settings-field-stack">
        <span>로컬 모델 파일</span>
        <div className="settings-file-row">
          <input
            ref={localModelInputRef}
            value={localModelPath}
            disabled={controlsBusy}
            onChange={(event) => {
              clearTestState();
              setLocalModelPath(event.target.value);
            }}
            placeholder="C:\\models\\my-model.gguf"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                submit();
              }
            }}
          />
          <button
            type="button"
            onClick={() => void pickLocalModelFile()}
            disabled={controlsBusy}
          >
            파일 선택
          </button>
        </div>
      </div>

      <div className="settings-field-stack">
        <span>mmproj 파일</span>
        <div className="settings-file-row">
          <input
            value={localMmprojPath}
            disabled={controlsBusy}
            onChange={(event) => {
              clearTestState();
              setLocalMmprojPath(event.target.value);
            }}
            placeholder="같은 폴더면 자동 탐지, 필요하면 직접 지정"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                submit();
              }
            }}
          />
          <button
            type="button"
            onClick={() => void pickLocalMmprojFile()}
            disabled={controlsBusy}
          >
            파일 선택
          </button>
        </div>
        <p className="muted-line modal-note">
          mmproj는 같은 폴더에서 자동으로 찾아보고, 안 잡히면 직접 지정할 수
          있습니다.
        </p>
      </div>
    </>
  );
}

type CodexSettingsFieldsProps = Pick<
  EngineSettingsPanelProps,
  | "clearTestState"
  | "codexModel"
  | "codexOauthPort"
  | "codexReasoningEffort"
  | "controlsBusy"
  | "setCodexModel"
  | "setCodexOauthPort"
  | "setCodexReasoningEffort"
  | "submit"
>;

function CodexSettingsFields({
  clearTestState,
  codexModel,
  codexOauthPort,
  codexReasoningEffort,
  controlsBusy,
  setCodexModel,
  setCodexOauthPort,
  setCodexReasoningEffort,
  submit,
}: CodexSettingsFieldsProps): React.JSX.Element {
  return (
    <>
      <label>
        Codex 모델
        <input
          value={codexModel}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setCodexModel(event.target.value);
          }}
          placeholder="gpt-5.5"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            }
          }}
        />
      </label>

      <div className="settings-field-stack">
        <span>생각</span>
        <div
          className="settings-preset-group"
          role="tablist"
          aria-label="Codex 생각"
        >
          {CODEX_REASONING_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`settings-preset-button ${codexReasoningEffort === option.id ? "active" : ""}`}
              onClick={() => {
                clearTestState();
                setCodexReasoningEffort(option.id);
              }}
              disabled={controlsBusy}
              aria-pressed={codexReasoningEffort === option.id}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="muted-line modal-note">
          {
            CODEX_REASONING_OPTIONS.find(
              (option) => option.id === codexReasoningEffort,
            )?.description
          }
        </p>
      </div>

      <label>
        openai-oauth 포트
        <input
          type="number"
          min={1}
          max={65535}
          step={1}
          value={codexOauthPort}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setCodexOauthPort(event.target.value);
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
