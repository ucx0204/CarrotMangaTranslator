import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import { changeRedactionView } from "./redactionWorkspaceModel";
import {
  canRestoreRedactionEdit,
  restoreRedactionEdit,
} from "./redactionSession";
import styles from "./RedactionWorkspace.module.css";

export function RedactionBatchActions({
  form,
  ids,
  onReview,
  onCopy,
}: {
  form: RedactionWorkspaceController;
  ids: string[];
  onReview: () => void;
  onCopy: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const { state, commit } = form;
  const view = state.workspace.view;
  const disabled = form.busy || form.drawing;
  return (
    <div className={styles.batchBar}>
      <span>
        {t("manualRedaction.selectedCount", { count: view.selectedIds.length })}
      </span>
      <Button
        size="sm"
        disabled={disabled || !ids.length}
        onClick={() =>
          commit((current) =>
            changeRedactionView(current, { selectedIds: ids }),
          )
        }
      >
        {t("manualRedaction.selectFiltered")}
      </Button>
      <Button
        size="sm"
        disabled={disabled || !view.selectedIds.length}
        onClick={() =>
          commit((current) => changeRedactionView(current, { selectedIds: [] }))
        }
      >
        {t("manualRedaction.clearSelection")}
      </Button>
      <Button
        size="sm"
        disabled={disabled || !view.selectedIds.length}
        onClick={onReview}
      >
        {t("manualRedaction.reviewSelection")}
      </Button>
      <Button
        size="sm"
        disabled={
          disabled ||
          !view.selectedIds.length ||
          !state.documents[view.currentId].strokes.length
        }
        onClick={onCopy}
      >
        {t("manualRedaction.copySelection")}
      </Button>
      <Button
        size="sm"
        disabled={
          disabled ||
          !canRestoreRedactionEdit(state, "undo", view.currentId, true)
        }
        onClick={() =>
          commit((current) =>
            restoreRedactionEdit(current, "undo", view.currentId, true),
          )
        }
      >
        {t("manualRedaction.undoBatch")}
      </Button>
      <Button
        size="sm"
        disabled={
          disabled ||
          !canRestoreRedactionEdit(state, "redo", view.currentId, true)
        }
        onClick={() =>
          commit((current) =>
            restoreRedactionEdit(current, "redo", view.currentId, true),
          )
        }
      >
        {t("manualRedaction.redoBatch")}
      </Button>
    </div>
  );
}
