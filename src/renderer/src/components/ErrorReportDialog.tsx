import React from "react";
import { useTranslation } from "react-i18next";
import type { ErrorReportContext } from "../../../shared/errorReportTypes";
import styles from "./ErrorReportDialog.module.css";
import { Button } from "./ui/Button";
import { TextField } from "./ui/Field";
import { Modal } from "./ui/Modal";
import {
  useErrorReportDialogModel,
  type ReportAction,
} from "./useErrorReportDialog";

export type ErrorReportDialogProps = {
  context: ErrorReportContext;
  onClose: () => void;
  fatal?: boolean;
  onRestart?: () => unknown | Promise<unknown>;
};

export function ErrorReportDialog({
  context,
  onClose,
  fatal = false,
  onRestart,
}: ErrorReportDialogProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useErrorReportDialogModel(context, onRestart);
  const busy = model.activeAction !== null;

  return (
    <Modal
      title={t(fatal ? "errorReport.fatalTitle" : "errorReport.title")}
      size="lg"
      onClose={onClose}
      closeDisabled={busy}
      closeOnBackdrop={!fatal}
      cardClassName={styles.card}
      bodyClassName={styles.body}
      footer={
        <ErrorReportFooter
          activeAction={model.activeAction}
          canShare={model.canShare}
          fatal={fatal}
          hasRestart={Boolean(onRestart)}
          onClose={onClose}
          onCopy={model.handleCopy}
          onGitHub={model.handleOpenIssue}
          onOpenLogs={model.handleOpenLogs}
          onRestart={model.handleRestart}
        />
      }
    >
      {fatal ? (
        <p className={styles.fatalHint}>{t("errorReport.fatalHint")}</p>
      ) : null}
      <p className={styles.privacyNotice} role="note">
        {t("errorReport.privacyWarning")}
      </p>
      {model.loadError ? (
        <div className={styles.loadError} role="alert">
          <p>{t("errorReport.prepareError")}</p>
          <Button size="sm" onClick={model.retry}>
            {t("errorReport.retry")}
          </Button>
        </div>
      ) : model.draftReady ? (
        <ErrorReportForm
          description={model.description}
          includeLogs={model.includeLogs}
          includeSystem={model.includeSystem}
          reportBody={model.reportBody}
          title={model.title}
          onDescriptionChange={model.setDescription}
          onIncludeLogsChange={model.setIncludeLogs}
          onIncludeSystemChange={model.setIncludeSystem}
          onTitleChange={model.setTitle}
        />
      ) : (
        <p className={styles.loading} role="status">
          {t("errorReport.preparing")}
        </p>
      )}
      {model.feedback ? (
        <p
          className={
            model.feedback.kind === "error"
              ? styles.actionError
              : styles.actionSuccess
          }
          role={model.feedback.kind === "error" ? "alert" : "status"}
        >
          {model.feedback.message}
        </p>
      ) : null}
    </Modal>
  );
}

function ErrorReportForm({
  description,
  includeLogs,
  includeSystem,
  reportBody,
  title,
  onDescriptionChange,
  onIncludeLogsChange,
  onIncludeSystemChange,
  onTitleChange,
}: {
  description: string;
  includeLogs: boolean;
  includeSystem: boolean;
  reportBody: string;
  title: string;
  onDescriptionChange: (value: string) => void;
  onIncludeLogsChange: (value: boolean) => void;
  onIncludeSystemChange: (value: boolean) => void;
  onTitleChange: (value: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const descriptionId = React.useId();
  const previewId = React.useId();
  return (
    <div className={styles.form}>
      <TextField
        label={t("errorReport.issueTitle")}
        value={title}
        maxLength={180}
        required
        onChange={(event) => onTitleChange(event.target.value)}
      />
      <label className={styles.field} htmlFor={descriptionId}>
        <span>{t("errorReport.descriptionLabel")}</span>
        <textarea
          id={descriptionId}
          value={description}
          rows={4}
          maxLength={1000}
          placeholder={t("errorReport.descriptionPlaceholder")}
          onChange={(event) => onDescriptionChange(event.target.value)}
        />
      </label>
      <fieldset className={styles.options}>
        <legend>{t("errorReport.includeHeading")}</legend>
        <label>
          <input
            type="checkbox"
            checked={includeSystem}
            onChange={(event) => onIncludeSystemChange(event.target.checked)}
          />
          <span>{t("errorReport.includeSystem")}</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={includeLogs}
            onChange={(event) => onIncludeLogsChange(event.target.checked)}
          />
          <span>{t("errorReport.includeLogs")}</span>
        </label>
      </fieldset>
      <label className={styles.field} htmlFor={previewId}>
        <span>{t("errorReport.preview")}</span>
        <textarea
          id={previewId}
          className={styles.preview}
          value={reportBody}
          rows={12}
          readOnly
          spellCheck={false}
        />
      </label>
    </div>
  );
}

function ErrorReportFooter({
  activeAction,
  canShare,
  fatal,
  hasRestart,
  onClose,
  onCopy,
  onGitHub,
  onOpenLogs,
  onRestart,
}: {
  activeAction: ReportAction | null;
  canShare: boolean;
  fatal: boolean;
  hasRestart: boolean;
  onClose: () => void;
  onCopy: () => void;
  onGitHub: () => void;
  onOpenLogs: () => void;
  onRestart: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const busy = activeAction !== null;
  return (
    <div className={styles.footerActions}>
      <Button className={styles.footerButton} onClick={onClose} disabled={busy}>
        {t("common.close")}
      </Button>
      <Button
        className={styles.footerButton}
        onClick={onOpenLogs}
        disabled={busy}
      >
        {activeAction === "logs"
          ? t("errorReport.openingLogs")
          : t("errorReport.openLogs")}
      </Button>
      <Button
        className={styles.footerButton}
        onClick={onCopy}
        disabled={!canShare}
      >
        {activeAction === "copy"
          ? t("errorReport.copying")
          : t("errorReport.copy")}
      </Button>
      {fatal && hasRestart ? (
        <Button
          className={styles.footerButton}
          onClick={onRestart}
          disabled={busy}
        >
          {activeAction === "restart"
            ? t("errorReport.restarting")
            : t("errorReport.restart")}
        </Button>
      ) : null}
      <Button
        className={styles.footerButton}
        variant="primary"
        onClick={onGitHub}
        disabled={!canShare}
      >
        {activeAction === "github"
          ? t("errorReport.openingGitHub")
          : t("errorReport.openGitHub")}
      </Button>
    </div>
  );
}
