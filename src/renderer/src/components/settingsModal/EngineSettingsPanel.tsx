import React from "react";
import { ApiSettingsFields } from "./ApiSettingsFields";
import { CodexSettingsFields } from "./CodexSettingsFields";
import {
  ContextTokensField,
  MaxTokensField,
  TranslationEngineSelector,
} from "./EngineCommonFields";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";
import { GemmaSettingsFields } from "./GemmaSettingsFields";

export function EngineSettingsPanel(
  props: EngineSettingsPanelProps,
): React.JSX.Element {
  return (
    <>
      <TranslationEngineSelector {...props} />
      <MaxTokensField {...props} />
      <ContextTokensField {...props} />
      <ProviderSettingsFields {...props} />
    </>
  );
}

function ProviderSettingsFields(
  props: EngineSettingsPanelProps,
): React.JSX.Element {
  if (props.modelProvider === "gemma") {
    return <GemmaSettingsFields {...props} />;
  }
  if (props.modelProvider === "openai-codex") {
    return <CodexSettingsFields {...props} />;
  }
  return <ApiSettingsFields {...props} />;
}
