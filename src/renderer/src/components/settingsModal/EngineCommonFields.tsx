import React from "react";
import {
  MAX_MAX_TOKENS,
  MIN_CONTEXT_TOKENS,
  MIN_MAX_TOKENS,
  MODEL_PROVIDER_OPTIONS,
} from "../settingsOptions";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";

type TranslationEngineSelectorProps = Pick<
  EngineSettingsPanelProps,
  "clearTestState" | "controlsBusy" | "modelProvider" | "setModelProvider"
>;

export function TranslationEngineSelector({
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

export function MaxTokensField({
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

type ContextTokensFieldProps = Pick<
  EngineSettingsPanelProps,
  | "clearTestState"
  | "contextTokens"
  | "controlsBusy"
  | "setContextTokens"
  | "submit"
>;

export function ContextTokensField({
  clearTestState,
  contextTokens,
  controlsBusy,
  setContextTokens,
  submit,
}: ContextTokensFieldProps): React.JSX.Element {
  return (
    <>
      <label>
        컨텍스트 길이
        <input
          type="number"
          min={MIN_CONTEXT_TOKENS}
          step={1024}
          value={contextTokens}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setContextTokens(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            }
          }}
        />
      </label>
      <p className="muted-line modal-note">
        입력, 이미지, 출력이 함께 들어가는 전체 토큰 공간입니다. 긴 페이지가
        중간에서 끊기면 이 값을 올리세요. 기본값은 16384입니다.
      </p>
    </>
  );
}
