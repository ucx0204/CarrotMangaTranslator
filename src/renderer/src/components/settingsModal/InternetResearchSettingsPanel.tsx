import React from "react";
import { useTranslation } from "react-i18next";
import type { CodexReasoningEffort } from "../../../../shared/settingsTypes";
import {
  RESEARCH_GEMMA_REASONING_EFFORTS,
  type ResearchGemmaPreset,
  type ResearchGemmaReasoningEffort,
  type TavilyAnalysisProvider,
} from "../../../../shared/internetResearchTypes";
import { Select } from "../ui/Select";
import { ApiSettingsFields } from "./ApiSettingsFields";
import { CodexSettingsFields } from "./CodexSettingsFields";
import {
  GenerationLimitsFields,
  ModelProviderCards,
} from "./EngineCommonFields";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";
import { GemmaSettingsFields } from "./GemmaSettingsFields";
import { SettingsSection } from "./SettingsSection";
import { TavilyAccessFields } from "./TavilyAccessFields";

export type InternetResearchSettingsPanelProps = EngineSettingsPanelProps & {
  researchTavilyAnalysisProvider: TavilyAnalysisProvider;
  researchGemmaPreset: ResearchGemmaPreset;
  researchGemmaReasoningEffort: ResearchGemmaReasoningEffort;
  researchGemmaMaxOutputTokens: string;
  researchGemmaContextTokens: string;
  researchApiModel: string;
  researchApiMaxOutputTokens: string;
  researchApiContextTokens: string;
  researchCodexModel: string;
  researchCodexReasoningEffort: CodexReasoningEffort;
  researchCodexMaxOutputTokens: string;
  researchCodexContextTokens: string;
  tavilyApiKey: string;
  tavilyMaxCreditsPerRun: string;
  setResearchTavilyAnalysisProvider: React.Dispatch<
    React.SetStateAction<TavilyAnalysisProvider>
  >;
  setResearchGemmaPreset: React.Dispatch<
    React.SetStateAction<ResearchGemmaPreset>
  >;
  setResearchGemmaReasoningEffort: React.Dispatch<
    React.SetStateAction<ResearchGemmaReasoningEffort>
  >;
  setResearchGemmaMaxOutputTokens: React.Dispatch<React.SetStateAction<string>>;
  setResearchGemmaContextTokens: React.Dispatch<React.SetStateAction<string>>;
  setResearchApiModel: React.Dispatch<React.SetStateAction<string>>;
  setResearchApiMaxOutputTokens: React.Dispatch<React.SetStateAction<string>>;
  setResearchApiContextTokens: React.Dispatch<React.SetStateAction<string>>;
  setResearchCodexModel: React.Dispatch<React.SetStateAction<string>>;
  setResearchCodexReasoningEffort: React.Dispatch<
    React.SetStateAction<CodexReasoningEffort>
  >;
  setResearchCodexMaxOutputTokens: React.Dispatch<React.SetStateAction<string>>;
  setResearchCodexContextTokens: React.Dispatch<React.SetStateAction<string>>;
  setTavilyApiKey: React.Dispatch<React.SetStateAction<string>>;
  setTavilyMaxCreditsPerRun: React.Dispatch<React.SetStateAction<string>>;
};

export function InternetResearchSettingsPanel(
  props: InternetResearchSettingsPanelProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-panel-stack settings-research-panel">
      <SettingsSection
        title={t("settings.research.tavily.title")}
        description={t("settings.research.tavily.description")}
      >
        <TavilyAccessFields
          apiKey={props.tavilyApiKey}
          maxCreditsPerRun={props.tavilyMaxCreditsPerRun}
          controlsBusy={props.controlsBusy}
          setApiKey={props.setTavilyApiKey}
          setMaxCreditsPerRun={props.setTavilyMaxCreditsPerRun}
          onChange={props.clearTestState}
        />
      </SettingsSection>
      <SettingsSection title={t("settings.research.analyzer.label")}>
        <ResearchAnalyzerSelector {...props} />
      </SettingsSection>
      {props.researchTavilyAnalysisProvider === "gemma" ? (
        <GemmaResearchSettings {...props} />
      ) : (
        <ApiResearchSettings {...props} />
      )}
      <CodexResearchSettings {...props} />
    </div>
  );
}

function ResearchAnalyzerSelector(
  props: InternetResearchSettingsPanelProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const selectedProvider =
    props.researchTavilyAnalysisProvider === "gemma" ? "gemma" : "openai-api";
  return (
    <ModelProviderCards
      ariaLabel={t("settings.research.analyzer.label")}
      controlsBusy={props.controlsBusy}
      providers={["gemma", "openai-api"]}
      selectedProvider={selectedProvider}
      onProviderChange={(provider) => {
        props.clearTestState();
        props.setResearchTavilyAnalysisProvider(
          provider === "gemma" ? "gemma" : "api",
        );
      }}
    />
  );
}

function GemmaResearchSettings(
  props: InternetResearchSettingsPanelProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <SettingsSection
        className="settings-provider-section"
        title={t("settings.options.providers.gemma.label")}
        description={t("settings.options.providers.gemma.description")}
      >
        <GemmaSettingsFields
          {...props}
          selectedPreset={props.researchGemmaPreset}
          setSelectedPreset={props.setResearchGemmaPreset}
        />
        <GemmaResearchReasoningField {...props} />
      </SettingsSection>
      <SettingsSection title={t("settings.engine.limits.title")}>
        <GenerationLimitsFields
          {...props}
          apiModel={props.researchApiModel}
          contextTokens={props.researchGemmaContextTokens}
          maxTokens={props.researchGemmaMaxOutputTokens}
          modelProvider="gemma"
          setContextTokens={props.setResearchGemmaContextTokens}
          setMaxTokens={props.setResearchGemmaMaxOutputTokens}
        />
      </SettingsSection>
    </>
  );
}

function GemmaResearchReasoningField(
  props: InternetResearchSettingsPanelProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-field-stack">
      <span>{t("settings.research.gemma.reasoning")}</span>
      <Select
        ariaLabel={t("settings.research.gemma.reasoning")}
        value={props.researchGemmaReasoningEffort}
        disabled={props.controlsBusy}
        options={RESEARCH_GEMMA_REASONING_EFFORTS.map((effort) => ({
          value: effort,
          label: t(`settings.options.reasoning.${effort}.label`),
        }))}
        onValueChange={(value) => {
          props.clearTestState();
          props.setResearchGemmaReasoningEffort(
            value as ResearchGemmaReasoningEffort,
          );
        }}
      />
      <p className="muted-line modal-note">
        {t(
          `settings.options.reasoning.${props.researchGemmaReasoningEffort}.description`,
        )}
      </p>
    </div>
  );
}

function ApiResearchSettings(
  props: InternetResearchSettingsPanelProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <SettingsSection
        className="settings-provider-section"
        title={t("settings.options.providers.api.label")}
        description={t("settings.options.providers.api.description")}
      >
        <ApiSettingsFields
          {...props}
          apiModel={props.researchApiModel}
          setApiModel={props.setResearchApiModel}
        />
      </SettingsSection>
      <SettingsSection title={t("settings.engine.limits.title")}>
        <GenerationLimitsFields
          {...props}
          apiModel={props.researchApiModel}
          contextTokens={props.researchApiContextTokens}
          maxTokens={props.researchApiMaxOutputTokens}
          modelProvider="openai-api"
          setContextTokens={props.setResearchApiContextTokens}
          setMaxTokens={props.setResearchApiMaxOutputTokens}
        />
      </SettingsSection>
    </>
  );
}

function CodexResearchSettings(
  props: InternetResearchSettingsPanelProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <SettingsSection
        title={t("settings.research.codex.title")}
        description={t("settings.research.codex.description")}
      >
        <CodexSettingsFields
          clearTestState={props.clearTestState}
          codexModel={props.researchCodexModel}
          codexReasoningEffort={props.researchCodexReasoningEffort}
          controlsBusy={props.controlsBusy}
          setCodexModel={props.setResearchCodexModel}
          setCodexReasoningEffort={props.setResearchCodexReasoningEffort}
        />
      </SettingsSection>
      <SettingsSection title={t("settings.engine.limits.title")}>
        <GenerationLimitsFields
          {...props}
          apiModel={props.researchApiModel}
          codexModel={props.researchCodexModel}
          contextFieldMode="model"
          contextTokens={props.researchCodexContextTokens}
          maxTokens={props.researchCodexMaxOutputTokens}
          modelProvider="openai-codex"
          setContextTokens={props.setResearchCodexContextTokens}
          setMaxTokens={props.setResearchCodexMaxOutputTokens}
        />
      </SettingsSection>
    </>
  );
}
