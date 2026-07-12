import React from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("components");
  const activeProvider = MODEL_PROVIDER_OPTIONS.find(
    (option) => option.id === modelProvider,
  );
  return (
    <div className="settings-field-stack">
      <span>{t("settings.engine.provider.label")}</span>
      <div
        className="settings-mode-group"
        role="tablist"
        aria-label={t("settings.engine.provider.label")}
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
            {t(option.labelKey)}
          </button>
        ))}
      </div>
      <p className="muted-line modal-note">
        {activeProvider ? t(activeProvider.descriptionKey) : null}
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
  const { t } = useTranslation("components");
  return (
    <>
      <label>
        {t("settings.engine.maxTokens.label")}
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
        {t("settings.engine.maxTokens.description")}
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
  const { t } = useTranslation("components");
  return (
    <>
      <label>
        {t("settings.engine.contextTokens.label")}
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
        {t("settings.engine.contextTokens.description")}
      </p>
    </>
  );
}
