import React from "react";
import { useTranslation } from "react-i18next";
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
  | "contextTokens"
  | "controlsBusy"
  | "maxTokens"
  | "setCodexModel"
  | "setCodexOauthPort"
  | "setCodexReasoningEffort"
  | "setContextTokens"
  | "setMaxTokens"
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
  const { t } = useTranslation("components");
  const preset = findCodexModelOption(codexModel);
  const { customPicked, locallyEditedModel, setCustomPicked } =
    useCustomCodexModelMode(codexModel, Boolean(preset));
  const showCustomInput = customPicked || !preset;

  return (
    <div className="settings-field-stack">
      <label>
        {t("settings.codex.model")}
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
          <option value={CUSTOM_CODEX_MODEL_OPTION}>
            {t("settings.codex.customModel")}
          </option>
        </select>
      </label>
      {showCustomInput ? (
        <input
          value={codexModel}
          disabled={controlsBusy}
          spellCheck={false}
          maxLength={120}
          aria-label={t("settings.codex.customModelAria")}
          onChange={(event) => {
            const nextModel = event.target.value;
            clearTestState();
            locallyEditedModel.current = nextModel;
            setCodexModel(nextModel);
          }}
          placeholder={t("settings.codex.modelPlaceholder")}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            }
          }}
        />
      ) : null}
      <p className="muted-line modal-note">
        {t("settings.codex.modelDescription")}
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
  const { t } = useTranslation("components");
  const model = findCodexModelOption(codexModel);
  const reasoningOptions = model
    ? CODEX_REASONING_OPTIONS.filter((option) =>
        supportsCodexReasoningEffort(model, option.id),
      )
    : CODEX_REASONING_OPTIONS;
  const activeReasoning = reasoningOptions.find(
    (option) => option.id === codexReasoningEffort,
  );

  return (
    <div className="settings-field-stack">
      <span>{t("settings.codex.reasoning.label")}</span>
      <div
        className="settings-preset-group"
        role="group"
        aria-label={t("settings.codex.reasoning.ariaLabel")}
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
            {t(option.labelKey)}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {activeReasoning ? t(activeReasoning.descriptionKey) : null}
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
  const { t } = useTranslation("components");
  return (
    <label>
      {t("settings.codex.oauthPort")}
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
