import React from "react";
import {
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
  findCodexModelOption,
  supportsCodexReasoningEffort,
} from "../settingsOptions";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";

const CUSTOM_CODEX_MODEL_OPTION = "__custom__";

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
  codexReasoningEffort,
  controlsBusy,
  setCodexModel,
  setCodexReasoningEffort,
  submit,
}: CodexSettingsFieldsProps): React.JSX.Element {
  const preset = findCodexModelOption(codexModel);
  const { customPicked, locallyEditedModel, setCustomPicked } =
    useCustomCodexModelMode(codexModel, Boolean(preset));
  const showCustomInput = customPicked || !preset;

  return (
    <div className="settings-field-stack">
      <label>
        Codex 모델
        <select
          value={showCustomInput ? CUSTOM_CODEX_MODEL_OPTION : codexModel}
          disabled={controlsBusy}
          onChange={(event) => {
            if (event.target.value === CUSTOM_CODEX_MODEL_OPTION) {
              setCustomPicked(true);
              return;
            }

            const nextModel = findCodexModelOption(event.target.value);
            if (!nextModel) {
              return;
            }
            clearTestState();
            locallyEditedModel.current = null;
            setCustomPicked(false);
            setCodexModel(nextModel.id);
            if (
              !supportsCodexReasoningEffort(nextModel, codexReasoningEffort)
            ) {
              setCodexReasoningEffort(nextModel.defaultReasoningEffort);
            }
          }}
        >
          {CODEX_MODEL_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
          <option value={CUSTOM_CODEX_MODEL_OPTION}>Custom (직접 입력)…</option>
        </select>
      </label>
      {showCustomInput ? (
        <input
          value={codexModel}
          disabled={controlsBusy}
          spellCheck={false}
          maxLength={120}
          aria-label="Codex 모델 직접 입력"
          onChange={(event) => {
            const nextModel = event.target.value;
            clearTestState();
            locallyEditedModel.current = nextModel;
            setCodexModel(nextModel);
          }}
          placeholder="예: gpt-5.6-sol"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            }
          }}
        />
      ) : null}
      <p className="muted-line modal-note">
        현재 Codex 카탈로그의 표시 모델입니다. 계정이나 배포에 따라 목록에 없는
        모델은 Custom으로 입력할 수 있습니다.
      </p>
    </div>
  );
}

function useCustomCodexModelMode(model: string, isPreset: boolean) {
  const [customPicked, setCustomPicked] = React.useState(!isPreset);
  const locallyEditedModel = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (locallyEditedModel.current === model) {
      locallyEditedModel.current = null;
      return;
    }
    setCustomPicked(!isPreset);
  }, [isPreset, model]);
  return { customPicked, locallyEditedModel, setCustomPicked };
}

function CodexReasoningField({
  clearTestState,
  codexModel,
  codexReasoningEffort,
  controlsBusy,
  setCodexReasoningEffort,
}: CodexSettingsFieldsProps): React.JSX.Element {
  const model = findCodexModelOption(codexModel);
  const reasoningOptions = model
    ? CODEX_REASONING_OPTIONS.filter((option) =>
        supportsCodexReasoningEffort(model, option.id),
      )
    : CODEX_REASONING_OPTIONS;

  return (
    <div className="settings-field-stack">
      <span>생각</span>
      <div
        className="settings-preset-group"
        role="tablist"
        aria-label="Codex 생각"
      >
        {reasoningOptions.map((option) => (
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
          reasoningOptions.find((option) => option.id === codexReasoningEffort)
            ?.description
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
