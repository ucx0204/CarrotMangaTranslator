import React from "react";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconEye,
  IconEyeOff,
  IconRestore,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ControlTooltip } from "./ui/ControlTooltip";
import { formatShortcutTextForPlatform } from "../lib/shortcuts/comboFromEvent";

export type CanvasActionBarProps = {
  canRedo: boolean;
  canUndo: boolean;
  compareAvailable: boolean;
  disabled: boolean;
  resetAvailable: boolean;
  peeking: boolean;
  redoLabel?: string | null;
  undoLabel?: string | null;
  onPeekToggle: () => void;
  onRedo: () => void;
  onResetPage: () => void;
  onUndo: () => void;
};

/**
 * Page-level actions that stay anchored to the canvas instead of moving with
 * whichever tool or inspector happens to be active.
 */
export function CanvasActionBar({
  canRedo,
  canUndo,
  compareAvailable,
  disabled,
  resetAvailable,
  peeking,
  redoLabel,
  undoLabel,
  onPeekToggle,
  onRedo,
  onResetPage,
  onUndo,
}: CanvasActionBarProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const undoTitle = formatShortcutTextForPlatform(
    undoLabel
      ? t("workspaceActions.undoNamed", { action: undoLabel })
      : t("workspaceActions.undo"),
  );
  const redoTitle = formatShortcutTextForPlatform(
    redoLabel
      ? t("workspaceActions.redoNamed", { action: redoLabel })
      : t("workspaceActions.redo"),
  );

  return (
    <nav className="canvas-action-bar" aria-label={t("workspaceActions.label")}>
      <HistoryActions
        canRedo={canRedo}
        canUndo={canUndo}
        disabled={disabled}
        redoTitle={redoTitle}
        undoTitle={undoTitle}
        onRedo={onRedo}
        onUndo={onUndo}
      />
      <div className="canvas-action-separator" aria-hidden="true" />
      <OriginalActions
        compareAvailable={compareAvailable}
        disabled={disabled}
        resetAvailable={resetAvailable}
        peeking={peeking}
        onPeekToggle={onPeekToggle}
        onResetPage={onResetPage}
      />
    </nav>
  );
}

function HistoryActions({
  canRedo,
  canUndo,
  disabled,
  redoTitle,
  undoTitle,
  onRedo,
  onUndo,
}: Pick<
  CanvasActionBarProps,
  "canRedo" | "canUndo" | "disabled" | "onRedo" | "onUndo"
> & {
  redoTitle: string;
  undoTitle: string;
}): React.JSX.Element {
  return (
    <div className="canvas-action-group history-actions">
      <ControlTooltip
        className="canvas-action-control"
        content={undoTitle}
        placement="left"
      >
        <button
          type="button"
          aria-label={undoTitle}
          disabled={disabled || !canUndo}
          onClick={onUndo}
        >
          <IconArrowBackUp size={22} stroke={2.15} aria-hidden="true" />
        </button>
      </ControlTooltip>
      <ControlTooltip
        className="canvas-action-control"
        content={redoTitle}
        placement="left"
      >
        <button
          type="button"
          aria-label={redoTitle}
          disabled={disabled || !canRedo}
          onClick={onRedo}
        >
          <IconArrowForwardUp size={22} stroke={2.15} aria-hidden="true" />
        </button>
      </ControlTooltip>
    </div>
  );
}

function OriginalActions({
  compareAvailable,
  disabled,
  resetAvailable,
  peeking,
  onPeekToggle,
  onResetPage,
}: Pick<
  CanvasActionBarProps,
  | "compareAvailable"
  | "disabled"
  | "resetAvailable"
  | "peeking"
  | "onPeekToggle"
  | "onResetPage"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const compareTitle = t(
    peeking
      ? "workspaceActions.hideOriginal"
      : "workspaceActions.compareOriginal",
  );
  return (
    <div className="canvas-action-group original-actions">
      <ControlTooltip
        className="canvas-action-control"
        content={compareTitle}
        placement="left"
      >
        <button
          type="button"
          className={peeking ? "active" : ""}
          aria-label={compareTitle}
          aria-pressed={peeking}
          disabled={disabled || !compareAvailable}
          onClick={onPeekToggle}
        >
          {peeking ? (
            <IconEyeOff size={22} stroke={2.15} aria-hidden="true" />
          ) : (
            <IconEye size={22} stroke={2.15} aria-hidden="true" />
          )}
        </button>
      </ControlTooltip>
      <ControlTooltip
        className="canvas-action-control"
        content={t("workspaceActions.resetPageTitle")}
        placement="left"
      >
        <button
          type="button"
          aria-label={t("workspaceActions.resetPage")}
          disabled={disabled || !resetAvailable}
          onClick={onResetPage}
        >
          <IconRestore size={22} stroke={2.15} aria-hidden="true" />
        </button>
      </ControlTooltip>
    </div>
  );
}
