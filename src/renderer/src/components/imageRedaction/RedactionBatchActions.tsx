import React from "react";
import { useTranslation } from "react-i18next";
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
  const select = (selectedIds: string[]) =>
    commit((current) => changeRedactionView(current, { selectedIds }));
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
    <>
      <div>
        <Button
          variant="ghost"
          size="sm"
          disabled={form.busy || form.drawing || !ids.length}
          onClick={() => select(ids)}
        >
          {t("manualRedaction.selectAllShort")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={form.busy || form.drawing || !count}
          onClick={() => select([])}
        >
          {t("manualRedaction.clearSelectionShort")}
        </Button>
      </div>
      <Button
        size="sm"
        fullWidth
        disabled={form.busy || form.drawing || !count}
        onClick={onReview}
      >
        {t("manualRedaction.reviewSelectedCount", { count })}
      </Button>
      <RedactionActionsMenu
        label={t("manualRedaction.selectionMenu")}
        disabled={form.busy || form.drawing}
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
    </>
  );
}
