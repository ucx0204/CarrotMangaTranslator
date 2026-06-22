import React from "react";
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
};

export function SettingsValidationMessages({
  apiAdvancedSettingsMessage,
  apiAdvancedSettingsValid,
  apiBaseUrlValid,
  codexOauthPortValid,
  contextTokensValid,
  maxTokensValid,
  modelProvider,
}: SettingsValidationMessagesProps): React.JSX.Element {
  return (
    <>
      {modelProvider === "openai-codex" && !codexOauthPortValid ? (
        <p className="muted-line">
          openai-oauth 포트는 1 이상 65535 이하의 정수여야 합니다.
        </p>
      ) : null}
      {modelProvider === "openai-api" && !apiBaseUrlValid ? (
        <p className="muted-line">
          API Base URL은 http 또는 https URL이어야 합니다.
        </p>
      ) : null}
      {modelProvider === "openai-api" && !apiAdvancedSettingsValid ? (
        <p className="muted-line">
          {apiAdvancedSettingsMessage ?? "고급 API 설정을 확인해 주세요."}
        </p>
      ) : null}
      {!maxTokensValid ? (
        <p className="muted-line">
          최대 출력 토큰은 {MIN_MAX_TOKENS} 이상 {MAX_MAX_TOKENS} 이하의
          정수여야 합니다.
        </p>
      ) : null}
      {!contextTokensValid ? (
        <p className="muted-line">
          컨텍스트 길이는 {MIN_CONTEXT_TOKENS} 이상의 정수여야 합니다.
        </p>
      ) : null}
    </>
  );
}
