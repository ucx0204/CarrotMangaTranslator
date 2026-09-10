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
      <Button
        size="sm"
        fullWidth
        disabled={form.busy || form.drawing || !count}
        onClick={onReview}
      >
        {t("manualRedaction.reviewSelection")}
      </Button>
      <RedactionActionsMenu
        label={t("manualRedaction.selectedCount", { count })}
        disabled={form.busy || form.drawing}
        items={[
          {
            label: t("manualRedaction.selectFiltered"),
            run: () => select(ids),
            disabled: !ids.length,
          },
          {
            label: t("manualRedaction.clearSelection"),
            run: () => select([]),
            disabled: !count,
          },
          {
            label: t("manualRedaction.copySelection"),
            run: onCopy,
            disabled: !count || !state.documents[view.currentId].strokes.length,
          },
          ...history,
        ]}
      />
    </>
  );
}
