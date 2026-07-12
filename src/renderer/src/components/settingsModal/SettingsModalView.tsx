import React from "react";
import { useTranslation } from "react-i18next";
import type { ModelProvider } from "../../../../shared/settingsTypes";
import { Button, Modal } from "../ui";
import { EngineSettingsPanel } from "./EngineSettingsPanel";
import { FormatDefaultsPanel } from "./FormatDefaultsPanel";
import { HardwareSettingsPanel } from "./HardwareSettingsPanel";
import { SettingsTabs } from "./SettingsTabs";
import { SettingsValidationMessages } from "./SettingsValidationMessages";
import { ShortcutsSettingsPanel } from "./ShortcutsSettingsPanel";
import { TestSettingsPanel } from "./TestSettingsPanel";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import type { SettingsTabId } from "../settingsModalTypes";

export type SettingsModalViewProps = {
  activeTab: SettingsTabId;
  canSubmit: boolean;
  controlsBusy: boolean;
  generalPanelProps: React.ComponentProps<typeof GeneralSettingsPanel>;
  enginePanelProps: React.ComponentProps<typeof EngineSettingsPanel>;
  hardwarePanelProps: React.ComponentProps<typeof HardwareSettingsPanel>;
  formatPanelProps: React.ComponentProps<typeof FormatDefaultsPanel>;
  onCancel: () => void;
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
  generalPanelProps,
  enginePanelProps,
  hardwarePanelProps,
  formatPanelProps,
  onCancel,
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
      width="min(720px, 100%)"
      ariaLabel={t("settings.title")}
      title={t("settings.title")}
      onClose={onCancel}
      closeDisabled={controlsBusy}
      footer={
        <SettingsModalFooter
          canSubmit={canSubmit}
          controlsBusy={controlsBusy}
          onCancel={onCancel}
          onOpenLogFolder={onOpenLogFolder}
          onReset={onReset}
          submit={submit}
        />
      }
    >
      <div className="settings-layout">
        <SettingsTabs activeTab={activeTab} onChange={setActiveTab} />
        <SettingsModalTabPanel
          activeTab={activeTab}
          generalPanelProps={generalPanelProps}
          enginePanelProps={enginePanelProps}
          hardwarePanelProps={hardwarePanelProps}
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
  onOpenLogFolder,
  onReset,
  submit,
}: Pick<
  SettingsModalViewProps,
  | "canSubmit"
  | "controlsBusy"
  | "onCancel"
  | "onOpenLogFolder"
  | "onReset"
  | "submit"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <Button
        variant="ghost"
        style={{ marginRight: "auto" }}
        onClick={onOpenLogFolder}
        disabled={controlsBusy}
      >
        {t("settings.footer.openLogs")}
      </Button>
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
  );
}

function SettingsModalTabPanel({
  activeTab,
  generalPanelProps,
  enginePanelProps,
  hardwarePanelProps,
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
  | "formatPanelProps"
  | "shortcutsPanelProps"
  | "testPanelProps"
  | "validationProps"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const showApplyNote = activeTab !== "shortcuts" && activeTab !== "general";
  return (
    <div
      className="settings-tabpanel modal-section"
      role="tabpanel"
      id={`settings-panel-${activeTab}`}
      aria-labelledby={`settings-tab-${activeTab}`}
    >
      {showApplyNote ? (
        <p className="muted-line modal-note">{t("settings.applyNextRun")}</p>
      ) : null}
      {activeTab === "general" ? (
        <GeneralSettingsPanel {...generalPanelProps} />
      ) : null}
      {activeTab === "engine" ? (
        <EngineSettingsPanel {...enginePanelProps} />
      ) : null}
      {activeTab === "hardware" ? (
        <HardwareSettingsPanel {...hardwarePanelProps} />
      ) : null}
      {activeTab === "format" ? (
        <FormatDefaultsPanel {...formatPanelProps} />
      ) : null}
      {activeTab === "shortcuts" ? (
        <ShortcutsSettingsPanel {...shortcutsPanelProps} />
      ) : null}
      {activeTab === "test" ? <TestSettingsPanel {...testPanelProps} /> : null}
      <SettingsValidationMessages {...validationProps} />
    </div>
  );
}
