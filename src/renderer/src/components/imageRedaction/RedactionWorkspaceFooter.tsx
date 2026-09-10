import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import { redactionProgress } from "./redactionSession";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  form: RedactionWorkspaceController;
  preparation: boolean;
  detailReady: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onConfirm: () => void;
  onDefer: () => void;
  onContinue: () => void;
  onExit: () => void;
};
export function RedactionWorkspaceFooter(props: Props): React.JSX.Element {
  const { form, preparation } = props;
  const { t } = useTranslation("components");
  const { state } = form;
  const progress = redactionProgress(state.documents);
  const index = state.workspace.pages.findIndex(
    (page) => page.id === state.workspace.view.currentId,
  );
  const disabled = form.busy || form.drawing;
  const nextAction = form.failed.size
    ? t("manualRedaction.gotoErrors", { count: form.failed.size })
    : progress.unreviewed
      ? t("manualRedaction.gotoUnreviewed", { count: progress.unreviewed })
      : progress.deferred
        ? t("manualRedaction.gotoDeferred", { count: progress.deferred })
        : t(
            preparation
              ? "manualRedaction.finishPreparation"
              : "manualRedaction.continueCount",
            { count: state.workspace.pages.length },
          );
  return (
    <div className={styles.dialogRows}>
      <div className={styles.progress} role="status" aria-live="polite">
        <strong>
          {t("manualRedaction.progress", {
            count: progress.reviewed,
            total: state.workspace.pages.length,
          })}
        </strong>
        <span className={styles.hint}>
          {t(`manualRedaction.save_${form.saveStatus.kind}`)}
        </span>
        {form.saveStatus.kind === "error" ? (
          <Button
            size="sm"
            onClick={() => {
              void form.flush().catch(form.report);
            }}
          >
            {t("imageRedaction.retry")}
          </Button>
        ) : null}
      </div>
      <div className={styles.footer}>
        <Button disabled={disabled || index <= 0} onClick={props.onPrevious}>
          {t("manualRedaction.previous")}
        </Button>
        <Button
          disabled={disabled || index >= state.workspace.pages.length - 1}
          onClick={props.onNext}
        >
          {t("manualRedaction.next")}
        </Button>
        <Button disabled={disabled} onClick={props.onDefer}>
          {t("manualRedaction.deferNext")}
        </Button>
        <Button
          disabled={disabled || !props.detailReady}
          onClick={props.onConfirm}
        >
          {t("manualRedaction.confirmNext")}
        </Button>
        <div className={styles.footerMain}>
          <Button disabled={disabled} onClick={props.onExit}>
            {t("manualRedaction.saveExit")}
          </Button>
          <Button
            variant="primary"
            disabled={disabled}
            onClick={props.onContinue}
          >
            {nextAction}
          </Button>
        </div>
      </div>
    </div>
  );
}
