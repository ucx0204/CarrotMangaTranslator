import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { GatherTextDirectFormatModal } from "./GatherTextDirectFormatModal";
import type { GatherTextFormatSelection } from "./useGatherTextFormatSelection";

export function GatherTextFormatSelectionBar({
  selection,
}: {
  selection: GatherTextFormatSelection;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!selection.isSelectionMode) return null;
  return (
    <div className="gather-text-selection-toolbar">
      <strong>
        {t("gatherText.selectedCount", { count: selection.selectedCount })}
      </strong>
      <div className="gather-text-selection-actions">
        <Button size="sm" variant="ghost" onClick={selection.selectAllVisible}>
          {t("gatherText.selectVisible")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={selection.clear}
          disabled={selection.selectedCount === 0}
        >
          {t("gatherText.clearSelection")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={selection.openFormatModal}
          disabled={selection.disabled || selection.selectedCount === 0}
          title={
            selection.disabled ? t("gatherText.formatDisabled") : undefined
          }
        >
          {t("gatherText.applyFormat")}
        </Button>
        <Button size="sm" variant="ghost" onClick={selection.exitSelectionMode}>
          {t("gatherText.exitSelectionMode")}
        </Button>
      </div>
      {selection.isFormatModalOpen ? (
        <GatherTextDirectFormatModal selection={selection} />
      ) : null}
    </div>
  );
}
