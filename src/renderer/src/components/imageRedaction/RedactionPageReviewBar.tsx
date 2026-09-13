import React from "react";
import { useTranslation } from "react-i18next";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { Button } from "../ui/Button";
import { NumberField } from "../ui/NumberField";
import { ControlTooltip } from "../ui/ControlTooltip";
import { useRedactionShortcutLabels } from "./useRedactionShortcutLabels";
import { RedactionIconButton } from "./RedactionIconButton";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  form: RedactionWorkspaceController;
  detailReady: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onReview: () => void;
  onOpen: (id: string, focusEditor?: boolean) => void;
};
export function RedactionPageReviewBar(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const { form } = props;
  const { view } = form.state.workspace;
  const reviewed =
    form.state.documents[view.currentId]?.decision === "reviewed";
  return (
    <div
      className={styles.pageReviewBar}
      role="group"
      aria-label={t("manualRedaction.pageReviewControls")}
    >
      <PageNavigation {...props} />
      {reviewed ? (
        <span className={styles.reviewedLabel} role="status">
          {t("manualRedaction.reviewedPage")}
        </span>
      ) : (
        <ControlTooltip
          content={t("manualRedaction.reviewPageHint")}
          placement="top"
        >
          <Button
            variant="primary"
            disabled={form.busy || form.drawing || !props.detailReady}
            onClick={props.onReview}
          >
            {t("manualRedaction.reviewPage")}
          </Button>
        </ControlTooltip>
      )}
    </div>
  );
}
function PageNavigation(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const { pages, view, preferences } = props.form.state.workspace;
  const index = pages.findIndex((page) => page.id === view.currentId);
  const disabled = props.form.busy || props.form.drawing;
  const keys = useRedactionShortcutLabels(preferences);
  return (
    <div className={styles.pageJump}>
      <RedactionIconButton
        label={t("manualRedaction.previous")}
        hint={`${t("manualRedaction.previous")} · ${keys("previous")}`}
        placement="top"
        disabled={disabled || index <= 0}
        onClick={props.onPrevious}
      >
        <IconChevronLeft size={18} aria-hidden="true" />
      </RedactionIconButton>
      <NumberField
        className={styles.pageNumber}
        variant="framed"
        commitMode="blur"
        ariaLabel={t("manualRedaction.jumpPage")}
        value={index + 1}
        min={1}
        max={pages.length}
        disabled={disabled}
        onValueChange={(number) => {
          const page = pages[number - 1];
          if (page) props.onOpen(page.id, false);
        }}
      />
      <span className={styles.hint}>/ {pages.length}</span>
      <RedactionIconButton
        label={t("manualRedaction.next")}
        hint={`${t("manualRedaction.next")} · ${keys("next")}`}
        placement="top"
        disabled={disabled || index >= pages.length - 1}
        onClick={props.onNext}
      >
        <IconChevronRight size={18} aria-hidden="true" />
      </RedactionIconButton>
    </div>
  );
}
