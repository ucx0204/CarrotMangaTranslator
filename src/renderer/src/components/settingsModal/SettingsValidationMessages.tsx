import React from "react";
import { useTranslation } from "react-i18next";
import type { ModelProvider } from "../../../../shared/settingsTypes";
import {
  MAX_MAX_TOKENS,
  MIN_CONTEXT_TOKENS,
  MIN_MAX_TOKENS,
} from "../settingsOptions";

type SettingsValidationMessagesProps = {
  apiAdvancedSettingsMessage?: string;
  apiAdvancedSettingsValid: boolean;
  apiBaseUrlValid: boolean;
  codexOauthPortValid: boolean;
  contextTokensValid: boolean;
  maxTokensValid: boolean;
  modelProvider: ModelProvider;
  sourceLanguageValid: boolean;
  targetLanguageValid: boolean;
};

export function SettingsValidationMessages({
  apiAdvancedSettingsMessage,
  apiAdvancedSettingsValid,
  apiBaseUrlValid,
  codexOauthPortValid,
  contextTokensValid,
  maxTokensValid,
  modelProvider,
  sourceLanguageValid,
  targetLanguageValid,
}: SettingsValidationMessagesProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      {!sourceLanguageValid || !targetLanguageValid ? (
        <p className="muted-line">{t("settings.validation.languageCode")}</p>
      ) : null}
      {modelProvider === "openai-codex" && !codexOauthPortValid ? (
        <p className="muted-line">{t("settings.validation.oauthPort")}</p>
      ) : null}
      {modelProvider === "openai-api" && !apiBaseUrlValid ? (
        <p className="muted-line">{t("settings.validation.apiBaseUrl")}</p>
      ) : null}
      {modelProvider === "openai-api" && !apiAdvancedSettingsValid ? (
        <p className="muted-line">
          {apiAdvancedSettingsMessage ?? t("settings.validation.apiAdvanced")}
        </p>
      ) : null}
      {!maxTokensValid ? (
        <p className="muted-line">
          {t("settings.validation.maxTokens", {
            min: MIN_MAX_TOKENS,
            max: MAX_MAX_TOKENS,
          })}
        </p>
      ) : null}
      {!contextTokensValid ? (
        <p className="muted-line">
          {t("settings.validation.contextTokens", {
            min: MIN_CONTEXT_TOKENS,
          })}
        </p>
      ) : null}
    </>
  );
}
