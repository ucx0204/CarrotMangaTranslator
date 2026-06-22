import React from "react";
import { CODEX_REASONING_OPTIONS } from "../settingsOptions";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";

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

export function CodexSettingsFields(
  props: CodexSettingsFieldsProps,
): React.JSX.Element {
  return (
    <>
      <CodexModelField {...props} />
      <CodexReasoningField {...props} />
      <CodexOauthPortField {...props} />
    </>
  );
}

function CodexModelField({
  clearTestState,
  codexModel,
  controlsBusy,
  setCodexModel,
  submit,
}: CodexSettingsFieldsProps): React.JSX.Element {
  return (
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
  );
}

function CodexReasoningField({
  clearTestState,
  codexReasoningEffort,
  controlsBusy,
  setCodexReasoningEffort,
}: CodexSettingsFieldsProps): React.JSX.Element {
  return (
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
  );
}

function CodexOauthPortField({
  clearTestState,
  codexOauthPort,
  controlsBusy,
  setCodexOauthPort,
  submit,
}: CodexSettingsFieldsProps): React.JSX.Element {
  return (
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
  );
}
