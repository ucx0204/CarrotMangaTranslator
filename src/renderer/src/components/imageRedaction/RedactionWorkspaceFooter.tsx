import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { ControlTooltip } from "../ui/ControlTooltip";
import type { RedactionSaveStatus } from "./redactionDraftWriter";
import type { RedactionWorkspaceSummary } from "./redactionWorkspacePresentation";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  progress: Pick<
    RedactionWorkspaceSummary,
    "reviewed" | "unreviewed" | "total"
  >;
  failedCount: number;
  disabled: boolean;
  saveStatus: RedactionSaveStatus;
  onRetrySave: () => void;
  preparation: boolean;
  onContinue: () => void;
  onUnreviewed: () => void;
  onIssue: () => void;
};

/** Task-level status and execution only; page review lives under the canvas. */
export function RedactionWorkspaceFooter(props: Props): React.JSX.Element {
  const { progress, failedCount, disabled, preparation } = props;
  const { t } = useTranslation("components");
  const progressId = React.useId();
  const unresolved = progress.unreviewed > 0 || failedCount > 0;
  return (
    <div className={styles.footer}>
      <div className={styles.progress}>
        <span id={progressId} aria-live="polite">
          {t("manualRedaction.reviewProgress", {
            count: progress.reviewed,
            total: progress.total,
            remaining: progress.unreviewed,
          })}
        </span>
        <RedactionSaveState
          status={props.saveStatus}
          disabled={disabled}
          onRetry={props.onRetrySave}
        />
      </div>
      {progress.unreviewed > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={props.onUnreviewed}
        >
          {t("manualRedaction.nextUnreviewed")}
        </Button>
      ) : null}
      {failedCount > 0 ? (
        <Button size="sm" disabled={disabled} onClick={props.onIssue}>
          {t("manualRedaction.gotoErrors", { count: failedCount })}
        </Button>
      ) : null}
      <div className={styles.footerMain}>
        <ControlTooltip
          content={t(
            preparation
              ? "manualRedaction.preparationHint"
              : "manualRedaction.outboundHint",
          )}
          placement="top"
        >
          <Button
            variant={unresolved && !preparation ? "secondary" : "primary"}
            disabled={disabled || (!preparation && unresolved)}
            aria-describedby={progressId}
            onClick={props.onContinue}
          >
            {t(
              preparation
                ? "manualRedaction.saveExit"
                : "manualRedaction.resumeJob",
            )}
          </Button>
        </ControlTooltip>
      </div>
    </div>
  );
}
function RedactionSaveState({
  status,
  disabled,
  onRetry,
}: {
  status: RedactionSaveStatus;
  disabled: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <span className={styles.saveState} role="status">
      {t(
        status.kind === "saved"
          ? "manualRedaction.savedShort"
          : `manualRedaction.save_${status.kind}`,
      )}
      {status.kind === "error" ? (
        <Button size="sm" disabled={disabled} onClick={onRetry}>
          {t("manualRedaction.retrySave")}
        </Button>
      ) : null}
    </span>
  );
}
