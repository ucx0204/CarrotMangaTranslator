import React from "react";
import type { ModelProvider } from "../../../../shared/types";
import { MAX_MAX_TOKENS, MIN_MAX_TOKENS } from "../settingsOptions";

type SettingsValidationMessagesProps = {
  codexOauthPortValid: boolean;
  maxTokensValid: boolean;
  modelProvider: ModelProvider;
};

export function SettingsValidationMessages({
  codexOauthPortValid,
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
      {!maxTokensValid ? (
        <p className="muted-line">
          최대 출력 토큰은 {MIN_MAX_TOKENS} 이상 {MAX_MAX_TOKENS} 이하의
          정수여야 합니다.
        </p>
      ) : null}
    </>
  );
}
