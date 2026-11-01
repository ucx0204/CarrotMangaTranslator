import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { ModalActionBar } from "../ui/ModalActionBar";
import type { SettingsSubmissionIssue } from "./settingsSubmissionIssue";
import styles from "./SettingsModalFooter.module.css";

type SettingsModalFooterProps = {
  canSubmit: boolean;
  submissionIssue?: SettingsSubmissionIssue;
  controlsBusy: boolean;
  onCancel: () => void;
  immediate?: boolean;
  isDirty?: boolean;
  onReset: () => void;
  submit: () => void;
  onRevealIssue: () => void;
};

export function SettingsModalFooter({
  canSubmit,
  submissionIssue,
  controlsBusy,
  onCancel,
  immediate = false,
  isDirty = false,
  onReset,
  submit,
  onRevealIssue,
}: SettingsModalFooterProps): React.JSX.Element {
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
          !(immediate && !isDirty) ? (
            <Button variant="ghost" onClick={onReset} disabled={controlsBusy}>
              {t("settings.footer.restoreDefaults")}
            </Button>
          ) : undefined
        }
        actions={
          immediate && !isDirty ? (
            <Button onClick={onCancel} disabled={controlsBusy}>
              {t("common.close")}
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={onCancel}
                disabled={controlsBusy}
              >
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
          )
        }
      />
    </div>
  );
}
