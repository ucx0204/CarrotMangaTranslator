import React from "react";
import { useTranslation } from "react-i18next";
import type { ModelProvider } from "../../../../shared/settingsTypes";
import type { LibraryIndex } from "../../../../shared/libraryTypes";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { ModalActionBar } from "../ui/ModalActionBar";
import { EngineSettingsPanel } from "./EngineSettingsPanel";
import { FormatDefaultsPanel } from "./FormatDefaultsPanel";
import { HardwareSettingsPanel } from "./HardwareSettingsPanel";
import { SettingsTabs } from "./SettingsTabs";
import { SettingsValidationMessages } from "./SettingsValidationMessages";
import { ShortcutsSettingsPanel } from "./ShortcutsSettingsPanel";
import { TestSettingsPanel } from "./TestSettingsPanel";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import type { SettingsTabId } from "../settingsModalTypes";
import { SETTINGS_TABS } from "../settingsModalTypes";
import { InfoIcon } from "../ui/icons";
import { LinkedWorkspaceSettingsPanel } from "./LinkedWorkspaceSettingsPanel";

export type SettingsModalViewProps = {
  activeTab: SettingsTabId;
  canSubmit: boolean;
  controlsBusy: boolean;
  defaultsPreviewActive: boolean;
  generalPanelProps: React.ComponentProps<typeof GeneralSettingsPanel>;
  enginePanelProps: React.ComponentProps<typeof EngineSettingsPanel>;
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
    codexOauthPortValid: boolean;
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
  controlsBusy,
  defaultsPreviewActive,
  generalPanelProps,
  enginePanelProps,
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
        {defaultsPreviewActive ? (
          <div className="settings-draft-notice" role="status">
            <InfoIcon size={18} />
            <div>
              <strong>{t("settings.defaultsPreview.title")}</strong>
              <span>{t("settings.defaultsPreview.description")}</span>
            </div>
          </div>
        ) : null}
        <SettingsTabs activeTab={activeTab} onChange={setActiveTab} />
        <SettingsModalTabPanel
          activeTab={activeTab}
          generalPanelProps={generalPanelProps}
          enginePanelProps={enginePanelProps}
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

function SettingsModalFooter({
  canSubmit,
  controlsBusy,
  onCancel,
  onOpenErrorReport,
  onOpenLogFolder,
  onReset,
  submit,
}: Pick<
  SettingsModalViewProps,
  | "canSubmit"
  | "controlsBusy"
  | "onCancel"
  | "onOpenErrorReport"
  | "onOpenLogFolder"
  | "onReset"
  | "submit"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      leading={
        <>
          <Button
            variant="ghost"
            onClick={onOpenLogFolder}
            disabled={controlsBusy}
          >
            {t("settings.footer.openLogs")}
          </Button>
          <Button
            variant="ghost"
            onClick={onOpenErrorReport}
            disabled={controlsBusy}
          >
            {t("settings.footer.reportProblem")}
          </Button>
        </>
      }
      actions={
        <>
          <Button onClick={onReset} disabled={controlsBusy}>
            {t("settings.footer.restoreDefaults")}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={controlsBusy}>
            {t("settings.footer.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={controlsBusy || !canSubmit}
          >
            {t("settings.footer.save")}
          </Button>
        </>
      }
    />
  );
}

function SettingsModalTabPanel({
  activeTab,
  generalPanelProps,
  enginePanelProps,
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
  | "hardwarePanelProps"
  | "library"
  | "formatPanelTitle"
  | "formatPanelProps"
  | "shortcutsPanelProps"
  | "testPanelProps"
  | "validationProps"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const activeTabOption = SETTINGS_TABS.find((tab) => tab.id === activeTab);
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
      <header className="settings-panel-header">
        <h2>
          {activeTab === "format"
            ? formatPanelTitle
            : activeTabOption
              ? t(activeTabOption.labelKey)
              : null}
        </h2>
      </header>
      <SettingsModalTabContent
        activeTab={activeTab}
        enginePanelProps={enginePanelProps}
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
  | "formatPanelProps"
  | "generalPanelProps"
  | "hardwarePanelProps"
  | "library"
  | "shortcutsPanelProps"
  | "testPanelProps"
  | "validationProps"
>;

function SettingsModalTabContent({
  activeTab,
  enginePanelProps,
  formatPanelProps,
  generalPanelProps,
  hardwarePanelProps,
  library,
  shortcutsPanelProps,
  testPanelProps,
  validationProps,
}: SettingsModalTabContentProps): React.JSX.Element | null {
  if (activeTab === "general")
    return <GeneralSettingsPanel {...generalPanelProps} />;
  if (activeTab === "hardware")
    return <HardwareSettingsPanel {...hardwarePanelProps} />;
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
    <>
      <EngineSettingsPanel {...enginePanelProps} />
      <div className="settings-validation-summary">
        <SettingsValidationMessages {...validationProps} />
      </div>
    </>
  );
}
