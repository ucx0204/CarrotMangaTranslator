import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { ModalActionBar } from "../ui/ModalActionBar";
import type { SettingsSubmissionIssue } from "./settingsSubmissionIssue";
import styles from "./SettingsModalFooter.module.css";

export function SettingsModalFooter({
  canSubmit,
  submissionIssue,
  controlsBusy,
  onCancel,
  onOpenErrorReport,
  onOpenLogFolder,
  onReset,
  submit,
  onRevealIssue,
}: {
  canSubmit: boolean;
  submissionIssue?: SettingsSubmissionIssue;
  controlsBusy: boolean;
  onCancel: () => void;
  onOpenErrorReport: () => void;
  onOpenLogFolder: () => void;
  onReset: () => void;
  submit: () => void;
  onRevealIssue: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={styles.root}>
      {submissionIssue ? (
        <div className={styles.issue} role="status">
          <span>{submissionIssue.message}</span>
          <Button size="sm" variant="ghost" onClick={onRevealIssue}>
            {t("settings.validation.goToField")}
          </Button>
        </div>
      ) : null}
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
              title={
                !canSubmit && !submissionIssue
                  ? t("settings.validation.unchanged")
                  : undefined
              }
            >
              {t("settings.footer.save")}
            </Button>
          </>
        }
      />
    </div>
  );
}
