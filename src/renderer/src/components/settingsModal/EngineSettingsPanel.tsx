import React from "react";
import { useTranslation } from "react-i18next";
import type { CodexAccountSnapshot } from "../../../../shared/codexAccountTypes";
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
      <ProviderAndLimitsSections {...props} />
    </div>
  );
}

function ProviderAndLimitsSections(
  props: EngineSettingsPanelProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const activeProvider = MODEL_PROVIDER_OPTIONS.find(
    (option) => option.id === props.modelProvider,
  );
  const title = activeProvider ? t(activeProvider.labelKey) : null;
  const description = activeProvider
    ? t(activeProvider.descriptionKey)
    : undefined;
  if (props.modelProvider === "openai-codex") {
    return (
      <CodexProviderAndLimits
        {...props}
        title={title}
        description={description}
      />
    );
  }
  return (
    <>
      <SettingsSection
        className="settings-provider-section"
        title={title}
        description={description}
      >
        <NonCodexProviderSettingsFields {...props} />
      </SettingsSection>
      <SettingsSection title={t("settings.engine.limits.title")}>
        <GenerationLimitsFields {...props} />
      </SettingsSection>
    </>
  );
}

function CodexProviderAndLimits(
  props: EngineSettingsPanelProps & {
    title: React.ReactNode;
    description?: React.ReactNode;
  },
): React.JSX.Element {
  const { t } = useTranslation("components");
  const [account, setAccount] = React.useState<CodexAccountSnapshot | null>(
    null,
  );
  const catalogReady =
    account?.authenticated === true && account.models.length > 0;
  const selectedModel = account?.models.find(
    (model) => model.id === props.codexModel,
  );
  return (
    <>
      <SettingsSection
        className="settings-provider-section"
        title={props.title}
        description={props.description}
      >
        <CodexSettingsFields {...props} onAccountSnapshotChange={setAccount} />
      </SettingsSection>
      {catalogReady ? (
        <SettingsSection title={t("settings.engine.limits.title")}>
          <GenerationLimitsFields
            {...props}
            codexModelLabel={selectedModel?.displayName}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}

function NonCodexProviderSettingsFields(
  props: EngineSettingsPanelProps,
): React.JSX.Element {
  if (props.modelProvider === "gemma") {
    return <GemmaSettingsFields {...props} />;
  }
  return <ApiSettingsFields {...props} />;
}
