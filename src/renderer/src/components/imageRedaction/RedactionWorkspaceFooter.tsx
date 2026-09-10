import React from "react";
import { useTranslation } from "react-i18next";
import {
  IconCheck,
  IconClockPause,
  IconChevronLeft,
  IconChevronRight,
  IconLoader2,
} from "@tabler/icons-react";
import { Button } from "../ui/Button";
import { NumberField } from "../ui/NumberField";
import { ControlTooltip } from "../ui/ControlTooltip";
import { RedactionIconButton } from "./RedactionIconButton";
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
  onOpen: (id: string) => void;
};
export function RedactionWorkspaceFooter(props: Props): React.JSX.Element {
  const { form, preparation } = props;
  const { t } = useTranslation("components");
  const progress = redactionProgress(form.state.documents);
  const total = form.state.workspace.pages.length;
  const unresolved =
    form.failed.size + progress.unreviewed + progress.deferred > 0;
  const disabled = form.busy || form.drawing;
  const hint = form.failed.size
    ? t("manualRedaction.gotoErrors", { count: form.failed.size })
    : progress.unreviewed
      ? t("manualRedaction.gotoUnreviewed", { count: progress.unreviewed })
      : progress.deferred
        ? t("manualRedaction.gotoDeferred", { count: progress.deferred })
        : t(
            preparation
              ? "manualRedaction.finishPreparation"
              : "manualRedaction.continueCount",
            { count: total },
          );
  return (
    <div className={styles.footer}>
      <div className={styles.progress}>
        <ControlTooltip content={hint} placement="top">
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || !unresolved}
            onClick={props.onContinue}
          >
            {t("manualRedaction.progress", { count: progress.reviewed, total })}
          </Button>
        </ControlTooltip>
        <RedactionSaveState form={form} />
      </div>
      <RedactionPageNavigation {...props} />
      <div className={styles.footerMain}>
        <RedactionIconButton
          label={t("manualRedaction.deferNext")}
          hint={`${t("manualRedaction.deferNext")} · Shift+Enter`}
          placement="top"
          disabled={disabled}
          onClick={props.onDefer}
        >
          <IconClockPause size={18} aria-hidden="true" />
        </RedactionIconButton>
        <Button
          variant={unresolved ? "primary" : "secondary"}
          disabled={disabled || !props.detailReady}
          onClick={props.onConfirm}
        >
          {t("manualRedaction.confirmNext")}
        </Button>
        <ControlTooltip content={hint} placement="top">
          <Button
            variant={unresolved ? "secondary" : "primary"}
            disabled={disabled || unresolved}
            onClick={props.onContinue}
          >
            {t(preparation ? "common.save" : "imageRedaction.confirm")}
          </Button>
        </ControlTooltip>
      </div>
    </div>
  );
}
function RedactionPageNavigation(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const { pages, view, preferences } = props.form.state.workspace;
  const index = pages.findIndex((page) => page.id === view.currentId);
  const disabled = props.form.busy || props.form.drawing;
  const key = (value: string) =>
    preferences.letterShortcuts ? value.toUpperCase() : "";
  return (
    <div className={styles.pageJump}>
      <RedactionIconButton
        label={t("manualRedaction.previous")}
        hint={`${t("manualRedaction.previous")} · ← ${key(preferences.previousKey)}`}
        placement="top"
        disabled={disabled || index <= 0}
        onClick={props.onPrevious}
      >
        <IconChevronLeft size={18} aria-hidden="true" />
      </RedactionIconButton>
      <NumberField
        className={styles.pageNumber}
        variant="framed"
        ariaLabel={t("manualRedaction.jumpPage")}
        value={index + 1}
        min={1}
        max={pages.length}
        disabled={disabled}
        onValueChange={(number) => {
          const page = pages[number - 1];
          if (page) props.onOpen(page.id);
        }}
      />
      <span className={styles.hint}>/ {pages.length}</span>
      <RedactionIconButton
        label={t("manualRedaction.next")}
        hint={`${t("manualRedaction.next")} · → ${key(preferences.nextKey)}`}
        placement="top"
        disabled={disabled || index >= pages.length - 1}
        onClick={props.onNext}
      >
        <IconChevronRight size={18} aria-hidden="true" />
      </RedactionIconButton>
    </div>
  );
}
function RedactionSaveState({
  form,
}: {
  form: RedactionWorkspaceController;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const label = t(`manualRedaction.save_${form.saveStatus.kind}`);
  if (form.saveStatus.kind === "error")
    return (
      <Button
        size="sm"
        disabled={form.busy}
        onClick={() => {
          void form.flush().catch(form.report);
        }}
      >
        {t("imageRedaction.retry")}
      </Button>
    );
  const Icon = form.saveStatus.kind === "saved" ? IconCheck : IconLoader2;
  return (
    <ControlTooltip content={label} placement="top">
      <span
        className={styles.saveState}
        tabIndex={0}
        role="status"
        aria-label={label}
      >
        <Icon size={16} aria-hidden="true" />
      </span>
    </ControlTooltip>
  );
}
