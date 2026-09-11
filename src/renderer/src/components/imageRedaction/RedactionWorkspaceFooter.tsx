import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { ControlTooltip } from "../ui/ControlTooltip";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import { redactionProgress } from "./redactionSession";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  form: RedactionWorkspaceController;
  preparation: boolean;
  onContinue: () => void;
  onUnreviewed: () => void;
  onIssue: () => void;
};

/** Task-level status and execution only; page review lives under the canvas. */
export function RedactionWorkspaceFooter(props: Props): React.JSX.Element {
  const { form, preparation } = props;
  const { t } = useTranslation("components");
  const progressId = React.useId();
  const progress = redactionProgress(form.state.documents);
  const total = form.state.workspace.pages.length;
  const disabled = form.busy || form.drawing;
  const unresolved = progress.unreviewed > 0 || form.failed.size > 0;
  return (
    <div className={styles.footer}>
      <div className={styles.progress}>
        <span id={progressId} aria-live="polite">
          {t("manualRedaction.reviewProgress", {
            count: progress.reviewed,
            total,
            remaining: progress.unreviewed,
          })}
        </span>
        <RedactionSaveState form={form} />
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
      {form.failed.size > 0 ? (
        <Button size="sm" disabled={disabled} onClick={props.onIssue}>
          {t("manualRedaction.gotoErrors", { count: form.failed.size })}
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
  form,
}: {
  form: RedactionWorkspaceController;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <span className={styles.saveState} role="status">
      {t(
        form.saveStatus.kind === "saved"
          ? "manualRedaction.savedShort"
          : `manualRedaction.save_${form.saveStatus.kind}`,
      )}
      {form.saveStatus.kind === "error" ? (
        <Button
          size="sm"
          disabled={form.busy}
          onClick={() => {
            void form.flush().catch(() => undefined);
          }}
        >
          {t("manualRedaction.retrySave")}
        </Button>
      ) : null}
    </span>
  );
}
