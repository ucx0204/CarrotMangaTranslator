import React from "react";
import { useTranslation } from "react-i18next";
import { ControlTooltip } from "../ui/ControlTooltip";
import styles from "./RedactionWorkspace.module.css";
import { Button } from "../ui/Button";
import { RedactionActionsMenu } from "./RedactionActionsMenu";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import { changeRedactionView } from "./redactionWorkspaceModel";
import {
  canRestoreRedactionEdit,
  restoreRedactionEdit,
} from "./redactionSession";

type Props = {
  form: RedactionWorkspaceController;
  ids: string[];
  onReview: () => void;
  onCopy: () => void;
};
export function RedactionBatchActions({
  form,
  ids,
  onReview,
  onCopy,
}: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const { state, commit } = form;
  const { view } = state.workspace;
  const count = view.selectedIds.length;
  const disabled = form.busy || form.drawing;
  const select = (selectedIds: string[]) =>
    commit((current) => changeRedactionView(current, { selectedIds }));
  return (
    <>
      <div className={styles.selectionTools}>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !ids.length}
          onClick={() => select(ids)}
        >
          {t("manualRedaction.selectAllShort")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !count}
          onClick={() => select([])}
        >
          {t("manualRedaction.clearSelectionShort")}
        </Button>
        <SelectionActions form={form} onCopy={onCopy} />
      </div>
      <ControlTooltip
        content={t("manualRedaction.explicitReviewHint")}
        placement="right"
      >
        <Button
          className={styles.selectionReview}
          size="sm"
          fullWidth
          disabled={disabled || !count}
          onClick={onReview}
        >
          {t("manualRedaction.reviewSelectedCount", { count })}
        </Button>
      </ControlTooltip>
    </>
  );
}

function SelectionActions({ form, onCopy }: Pick<Props, "form" | "onCopy">) {
  const { t } = useTranslation("components");
  const { state, commit } = form;
  const { view } = state.workspace;
  const count = view.selectedIds.length;
  const disabled = form.busy || form.drawing;
  const history = (["undo", "redo"] as const).map((direction) => ({
    label: t(
      direction === "undo"
        ? "manualRedaction.undoBatch"
        : "manualRedaction.redoBatch",
    ),
    disabled: !canRestoreRedactionEdit(state, direction, view.currentId, true),
    run: () =>
      commit((current) =>
        restoreRedactionEdit(current, direction, view.currentId, true),
      ),
  }));
  return (
    <RedactionActionsMenu
      iconOnly
      align="start"
      label={t("manualRedaction.selectionMenu")}
      disabled={disabled}
      items={[
        {
          label: t("manualRedaction.copySelection"),
          run: onCopy,
          disabled: !count || !state.documents[view.currentId].strokes.length,
        },
        ...history,
        ...(["masked", "error"] as const).map((filter) => ({
          label: t(`manualRedaction.filter_${filter}`),
          run: () =>
            commit((current) =>
              changeRedactionView(current, { filter, gridOffset: 0 }),
            ),
        })),
      ]}
    />
  );
}
