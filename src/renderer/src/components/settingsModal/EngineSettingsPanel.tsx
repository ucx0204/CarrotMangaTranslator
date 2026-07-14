import React from "react";
import { useTranslation } from "react-i18next";
import { MODEL_PROVIDER_OPTIONS } from "../settingsOptions";
import { ApiSettingsFields } from "./ApiSettingsFields";
import { CodexSettingsFields } from "./CodexSettingsFields";
import {
  GenerationLimitsFields,
  TranslationEngineSelector,
} from "./EngineCommonFields";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";
import { GemmaSettingsFields } from "./GemmaSettingsFields";
import { TranslationLanguageFields } from "./TranslationLanguageFields";
import { SettingsSection } from "./SettingsSection";

export function EngineSettingsPanel(
  props: EngineSettingsPanelProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const activeProvider = MODEL_PROVIDER_OPTIONS.find(
    (option) => option.id === props.modelProvider,
  );
  return (
    <div className="settings-panel-stack">
      <SettingsSection title={t("settings.engine.provider.label")}>
        <TranslationEngineSelector {...props} />
      </SettingsSection>
      <SettingsSection
        title={t("settings.translation.title")}
        description={t("settings.translation.description")}
      >
        <TranslationLanguageFields {...props} />
      </SettingsSection>
      <SettingsSection
        className="settings-provider-section"
        title={activeProvider ? t(activeProvider.labelKey) : null}
        description={
          activeProvider ? t(activeProvider.descriptionKey) : undefined
        }
      >
        <ProviderSettingsFields {...props} />
      </SettingsSection>
      <SettingsSection title={t("settings.engine.limits.title")}>
        <GenerationLimitsFields {...props} />
      </SettingsSection>
    </div>
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
