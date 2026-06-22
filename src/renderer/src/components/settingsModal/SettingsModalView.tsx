import React from "react";
import type { ModelProvider } from "../../../../shared/settingsTypes";
import { Button, Modal } from "../ui";
import { EngineSettingsPanel } from "./EngineSettingsPanel";
import { HardwareSettingsPanel } from "./HardwareSettingsPanel";
import { SettingsTabs } from "./SettingsTabs";
import { SettingsValidationMessages } from "./SettingsValidationMessages";
import { TestSettingsPanel } from "./TestSettingsPanel";
import type { SettingsTabId } from "../settingsModalTypes";

export type SettingsModalViewProps = {
  activeTab: SettingsTabId;
  canSubmit: boolean;
  controlsBusy: boolean;
  enginePanelProps: React.ComponentProps<typeof EngineSettingsPanel>;
  hardwarePanelProps: React.ComponentProps<typeof HardwareSettingsPanel>;
  onCancel: () => void;
  onOpenLogFolder: () => void;
  onReset: () => void;
  setActiveTab: React.Dispatch<React.SetStateAction<SettingsTabId>>;
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
  };
};

export function SettingsModalView({
  activeTab,
  canSubmit,
  controlsBusy,
  enginePanelProps,
  hardwarePanelProps,
  onCancel,
  onOpenLogFolder,
  onReset,
  setActiveTab,
  submit,
  testPanelProps,
  validationProps,
}: SettingsModalViewProps): React.JSX.Element {
  return (
    <Modal
      width="min(720px, 100%)"
      ariaLabel="설정"
      title="설정"
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
          enginePanelProps={enginePanelProps}
          hardwarePanelProps={hardwarePanelProps}
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
  return (
    <>
      <Button
        variant="ghost"
        style={{ marginRight: "auto" }}
        onClick={onOpenLogFolder}
        disabled={controlsBusy}
      >
        로그 폴더 열기
      </Button>
      <Button onClick={onReset} disabled={controlsBusy}>
        기본값 복원
      </Button>
      <Button variant="ghost" onClick={onCancel} disabled={controlsBusy}>
        취소
      </Button>
      <Button
        variant="primary"
        onClick={submit}
        disabled={controlsBusy || !canSubmit}
      >
        저장
      </Button>
    </>
  );
}

function SettingsModalTabPanel({
  activeTab,
  enginePanelProps,
  hardwarePanelProps,
  testPanelProps,
  validationProps,
}: Pick<
  SettingsModalViewProps,
  | "activeTab"
  | "enginePanelProps"
  | "hardwarePanelProps"
  | "testPanelProps"
  | "validationProps"
>): React.JSX.Element {
  return (
    <div
      className="settings-tabpanel modal-section"
      role="tabpanel"
      id={`settings-panel-${activeTab}`}
      aria-labelledby={`settings-tab-${activeTab}`}
    >
      <p className="muted-line modal-note">다음 번 번역 실행부터 적용됩니다.</p>
      {activeTab === "engine" ? (
        <EngineSettingsPanel {...enginePanelProps} />
      ) : null}
      {activeTab === "hardware" ? (
        <HardwareSettingsPanel {...hardwarePanelProps} />
      ) : null}
      {activeTab === "test" ? <TestSettingsPanel {...testPanelProps} /> : null}
      <SettingsValidationMessages {...validationProps} />
    </div>
  );
}
