import React from "react";
import { McpSettingsPanel } from "./McpSettingsPanel";
import { useTranslation } from "react-i18next";
import type { ModelProvider } from "../../../../shared/settingsTypes";
import type { LibraryIndex } from "../../../../shared/libraryTypes";
import { SettingsModalFooter } from "./SettingsModalFooter";
import { Modal } from "../ui/Modal";
import { EngineSettingsPanel } from "./EngineSettingsPanel";
import { FormatDefaultsPanel } from "./FormatDefaultsPanel";
import {
  HardwareSettingsPanel,
  OcrSettingsSection,
} from "./HardwareSettingsPanel";
import { SettingsTabs } from "./SettingsTabs";
import { SettingsValidationMessages } from "./SettingsValidationMessages";
import { ShortcutsSettingsPanel } from "./ShortcutsSettingsPanel";
import { TestSettingsPanel } from "./TestSettingsPanel";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import type { SettingsTabId } from "../settingsModalTypes";
import type { SettingsSubmissionIssue } from "./settingsSubmissionIssue";
import { InfoIcon } from "../ui/icons";
import { LinkedWorkspaceSettingsPanel } from "./LinkedWorkspaceSettingsPanel";
import { InternetResearchSettingsPanel } from "./InternetResearchSettingsPanel";
import { Tabs } from "../ui/Tabs";
import { ImageSettingsPanel } from "./ImageSettingsPanel";

export type SettingsModalViewProps = {
  activeTab: SettingsTabId;
  canSubmit: boolean;
  submissionIssue?: SettingsSubmissionIssue;
  controlsBusy: boolean;
  defaultsPreviewActive: boolean;
  generalPanelProps: React.ComponentProps<typeof GeneralSettingsPanel>;
  enginePanelProps: React.ComponentProps<typeof EngineSettingsPanel>;
  researchPanelProps: React.ComponentProps<
    typeof InternetResearchSettingsPanel
  >;
  hardwarePanelProps: React.ComponentProps<typeof HardwareSettingsPanel>;
  library?: LibraryIndex;
  formatPanelTitle: string;
  formatPanelProps: React.ComponentProps<typeof FormatDefaultsPanel>;
  onCancel: () => void;
  onOpenErrorReport: () => void;
  onOpenLogFolder: () => void;
  onReset: () => void;
  setActiveTab: React.Dispatch<React.SetStateAction<SettingsTabId>>;
  shortcutsPanelProps: React.ComponentProps<typeof ShortcutsSettingsPanel>;
  submit: () => void;
  testPanelProps: React.ComponentProps<typeof TestSettingsPanel>;
  validationProps: {
    apiAdvancedSettingsMessage?: string;
    apiAdvancedSettingsValid: boolean;
    apiBaseUrlValid: boolean;
    contextTokensValid: boolean;
    maxTokensValid: boolean;
    modelProvider: ModelProvider;
    sourceLanguageValid: boolean;
    targetLanguageValid: boolean;
  };
};

export function SettingsModalView({
  activeTab,
  canSubmit,
  submissionIssue,
  controlsBusy,
  defaultsPreviewActive,
  generalPanelProps,
  enginePanelProps,
  researchPanelProps,
  hardwarePanelProps,
  library,
  formatPanelTitle,
  formatPanelProps,
  onCancel,
  onOpenErrorReport,
  onOpenLogFolder,
  onReset,
  setActiveTab,
  shortcutsPanelProps,
  submit,
  testPanelProps,
  validationProps,
}: SettingsModalViewProps): React.JSX.Element {
  const [activeLlmTab, setActiveLlmTab] =
    React.useState<LlmSettingsTab>("translation");
  const navigation = { activeLlmTab, setActiveLlmTab };
  const revealIssue = useRevealSettingsIssue(
    submissionIssue,
    setActiveTab,
    setActiveLlmTab,
  );
  const { t } = useTranslation("components");
  return (
    <Modal
      width="min(920px, 100%)"
      fillHeight
      title={t("settings.title")}
      bodyClassName="settings-modal-body"
      onClose={onCancel}
      closeDisabled={controlsBusy}
      footer={
        <SettingsModalFooter
          canSubmit={canSubmit}
          submissionIssue={submissionIssue}
          onRevealIssue={revealIssue}
          controlsBusy={controlsBusy}
          onCancel={onCancel}
          onOpenErrorReport={onOpenErrorReport}
          onOpenLogFolder={onOpenLogFolder}
          onReset={onReset}
          submit={submit}
        />
      }
    >
      <div className="settings-layout">
        {defaultsPreviewActive ? <SettingsDefaultsNotice /> : null}
        <SettingsTabs activeTab={activeTab} onChange={setActiveTab} />
        <SettingsModalTabPanel
          activeTab={activeTab}
          navigation={navigation}
          generalPanelProps={generalPanelProps}
          enginePanelProps={enginePanelProps}
          researchPanelProps={researchPanelProps}
          hardwarePanelProps={hardwarePanelProps}
          library={library}
          formatPanelTitle={formatPanelTitle}
          formatPanelProps={formatPanelProps}
          shortcutsPanelProps={shortcutsPanelProps}
          testPanelProps={testPanelProps}
          validationProps={validationProps}
        />
      </div>
    </Modal>
  );
}

function SettingsModalTabPanel({
  activeTab,
  navigation,
  generalPanelProps,
  enginePanelProps,
  researchPanelProps,
  hardwarePanelProps,
  library,
  formatPanelTitle,
  formatPanelProps,
  shortcutsPanelProps,
  testPanelProps,
  validationProps,
}: Pick<
  SettingsModalViewProps,
  | "activeTab"
  | "generalPanelProps"
  | "enginePanelProps"
  | "researchPanelProps"
  | "hardwarePanelProps"
  | "library"
  | "formatPanelTitle"
  | "formatPanelProps"
  | "shortcutsPanelProps"
  | "testPanelProps"
  | "validationProps"
> & { navigation: LlmNavigation }): React.JSX.Element {
  return (
    <div
      className={[
        "settings-tabpanel",
        "modal-section",
        activeTab === "format" ? "settings-tabpanel-format" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="tabpanel"
      id={`settings-panel-${activeTab}`}
      aria-labelledby={`settings-tab-${activeTab}`}
    >
      {activeTab === "format" ? (
        <header className="settings-panel-header">
          <h2>{formatPanelTitle}</h2>
        </header>
      ) : null}
      <SettingsModalTabContent
        activeTab={activeTab}
        navigation={navigation}
        enginePanelProps={enginePanelProps}
        researchPanelProps={researchPanelProps}
        formatPanelProps={formatPanelProps}
        generalPanelProps={generalPanelProps}
        hardwarePanelProps={hardwarePanelProps}
        library={library}
        shortcutsPanelProps={shortcutsPanelProps}
        testPanelProps={testPanelProps}
        validationProps={validationProps}
      />
    </div>
  );
}

type SettingsModalTabContentProps = Pick<
  SettingsModalViewProps,
  | "activeTab"
  | "enginePanelProps"
  | "researchPanelProps"
  | "formatPanelProps"
  | "generalPanelProps"
  | "hardwarePanelProps"
  | "library"
  | "shortcutsPanelProps"
  | "testPanelProps"
  | "validationProps"
> & { navigation: LlmNavigation };

function SettingsModalTabContent({
  activeTab,
  navigation,
  enginePanelProps,
  researchPanelProps,
  formatPanelProps,
  generalPanelProps,
  hardwarePanelProps,
  library,
  shortcutsPanelProps,
  testPanelProps,
  validationProps,
}: SettingsModalTabContentProps): React.JSX.Element | null {
  if (activeTab === "mcp") return <McpSettingsPanel />;
  if (activeTab === "general")
    return <GeneralSettingsPanel {...generalPanelProps} />;
  if (activeTab === "format")
    return <FormatDefaultsPanel {...formatPanelProps} />;
  if (activeTab === "shortcuts")
    return <ShortcutsSettingsPanel {...shortcutsPanelProps} />;
  if (activeTab === "test") return <TestSettingsPanel {...testPanelProps} />;
  if (activeTab === "results") {
    return library ? <LinkedWorkspaceSettingsPanel library={library} /> : null;
  }
  if (activeTab !== "engine") return null;
  return (
    <LlmSettingsPanel
      navigation={navigation}
      hardwarePanelProps={hardwarePanelProps}
      enginePanelProps={enginePanelProps}
      researchPanelProps={researchPanelProps}
      validationProps={validationProps}
    />
  );
}

type LlmSettingsTab = "translation" | "ocr" | "image" | "research" | "hardware";

type LlmNavigation = {
  activeLlmTab: LlmSettingsTab;
  setActiveLlmTab: (tab: LlmSettingsTab) => void;
};

function LlmSettingsPanel({
  navigation,
  hardwarePanelProps,
  enginePanelProps,
  researchPanelProps,
  validationProps,
}: Pick<
  SettingsModalViewProps,
  | "enginePanelProps"
  | "researchPanelProps"
  | "validationProps"
  | "hardwarePanelProps"
> & { navigation: LlmNavigation }): React.JSX.Element {
  const { t } = useTranslation("components");
  const { activeLlmTab, setActiveLlmTab } = navigation;
  const items = (
    [
      ["translation", "settings.tabs.translation"],
      ["ocr", "settings.hardware.ocrSection"],
      ["image", "settings.tabs.image"],
      ["research", "settings.tabs.research"],
      ["hardware", "settings.tabs.hardware"],
    ] as const
  ).map(([value, key]) => ({
    value,
    label: t(key),
    id: `settings-llm-tab-${value}`,
    panelId: `settings-llm-panel-${value}`,
  }));
  return (
    <div className="settings-llm-panel">
      <Tabs
        className="settings-llm-tabs"
        ariaLabel={t("settings.tabs.llmAriaLabel")}
        items={items}
        value={activeLlmTab}
        onChange={setActiveLlmTab}
      />
      <div
        className="settings-llm-tabpanel"
        role="tabpanel"
        id={`settings-llm-panel-${activeLlmTab}`}
        aria-labelledby={`settings-llm-tab-${activeLlmTab}`}
      >
        {activeLlmTab === "translation" ? (
          <>
            <EngineSettingsPanel {...enginePanelProps} />
            <div className="settings-validation-summary">
              <SettingsValidationMessages {...validationProps} />
            </div>
          </>
        ) : activeLlmTab === "hardware" ? (
          <HardwareSettingsPanel {...hardwarePanelProps} />
        ) : activeLlmTab === "ocr" ? (
          <OcrSettingsSection {...hardwarePanelProps} />
        ) : activeLlmTab === "image" ? (
          <ImageSettingsPanel
            engine={enginePanelProps}
            hardware={hardwarePanelProps}
          />
        ) : (
          <InternetResearchSettingsPanel {...researchPanelProps} />
        )}
      </div>
    </div>
  );
}

function focusSettingsIssue(issue: SettingsSubmissionIssue): void {
  const panel = document.getElementById(`settings-llm-panel-${issue.tab}`);
  const controls = panel?.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement
  >("input, textarea, select, button");
  const target = Array.from(controls ?? []).find(
    (control) =>
      control.getAttribute("aria-label") === issue.label ||
      control.closest("label")?.textContent?.trim().startsWith(issue.label),
  );
  const focusTarget =
    target ?? document.getElementById(`settings-llm-tab-${issue.tab}`);
  focusTarget?.focus();
  target?.scrollIntoView({ block: "center" });
}

function useRevealSettingsIssue(
  issue: SettingsSubmissionIssue | undefined,
  setActiveTab: SettingsModalViewProps["setActiveTab"],
  setActiveLlmTab: LlmNavigation["setActiveLlmTab"],
) {
  const frame = React.useRef(0);
  React.useEffect(() => () => cancelAnimationFrame(frame.current), []);
  return React.useCallback(() => {
    if (!issue) return;
    cancelAnimationFrame(frame.current);
    setActiveTab("engine");
    setActiveLlmTab(issue.tab);
    frame.current = requestAnimationFrame(() => focusSettingsIssue(issue));
  }, [issue, setActiveTab, setActiveLlmTab]);
}

function SettingsDefaultsNotice(): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-draft-notice" role="status">
      <InfoIcon size={18} />
      <div>
        <strong>{t("settings.defaultsPreview.title")}</strong>
        <span>{t("settings.defaultsPreview.description")}</span>
      </div>
    </div>
  );
}
