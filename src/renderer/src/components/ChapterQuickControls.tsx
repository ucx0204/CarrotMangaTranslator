import React from "react";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconBorderAll,
  IconEye,
  IconEyeOff,
  IconBook2,
  IconListDetails,
  IconRestore,
  IconSquareLetterT,
  type TablerIcon,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatShortcutTextForPlatform } from "../lib/shortcuts/comboFromEvent";
import { ControlTooltip } from "./ui/ControlTooltip";

export type ChapterQuickControlsProps = {
  canRedo: boolean;
  canUndo: boolean;
  chapterAvailable: boolean;
  compareAvailable: boolean;
  disabled: boolean;
  id?: string;
  peeking: boolean;
  redoLabel?: string | null;
  resetAvailable: boolean;
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  undoLabel?: string | null;
  onPeekToggle: () => void;
  onOpenStyleGuide: () => void;
  onOpenTextView: () => void;
  onRedo: () => void;
  onResetPage: () => void;
  onToggleBlocks: () => void;
  onToggleChrome: () => void;
  onUndo: () => void;
};

/** Page and display controls shared by the external right-side quick rail. */
export function ChapterQuickControls(
  props: ChapterQuickControlsProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const undoTitle = formatShortcutTextForPlatform(
    props.undoLabel
      ? t("workspaceActions.undoNamed", { action: props.undoLabel })
      : t("workspaceActions.undo"),
  );
  const redoTitle = formatShortcutTextForPlatform(
    props.redoLabel
      ? t("workspaceActions.redoNamed", { action: props.redoLabel })
      : t("workspaceActions.redo"),
  );
  const compareTitle = t(
    props.peeking
      ? "workspaceActions.hideOriginal"
      : "workspaceActions.compareOriginal",
  );
  return (
    <div
      className="chapter-quick-controls"
      id={props.id}
      role="toolbar"
      aria-label={t("workspaceActions.label")}
    >
      <QuickControl
        disabled={props.disabled || !props.canUndo}
        Icon={IconArrowBackUp}
        label={undoTitle}
        onClick={props.onUndo}
      />
      <QuickControl
        disabled={props.disabled || !props.canRedo}
        Icon={IconArrowForwardUp}
        label={redoTitle}
        onClick={props.onRedo}
      />
      <QuickControl
        active={props.peeking}
        disabled={props.disabled || !props.compareAvailable}
        Icon={props.peeking ? IconEyeOff : IconEye}
        label={compareTitle}
        onClick={props.onPeekToggle}
      />
      <QuickControl
        disabled={props.disabled || !props.resetAvailable}
        Icon={IconRestore}
        label={t("workspaceActions.resetPageTitle")}
        onClick={props.onResetPage}
      />
      <div className="chapter-quick-separator" role="separator" />
      <QuickControl
        active={props.showTextBlocks}
        Icon={IconSquareLetterT}
        label={t("workspaceActions.showTranslations")}
        onClick={props.onToggleBlocks}
      />
      <QuickControl
        active={props.showBlockChrome}
        Icon={IconBorderAll}
        label={t("workspaceActions.showEditingChrome")}
        onClick={props.onToggleChrome}
      />
      <QuickControl
        disabled={!props.chapterAvailable}
        Icon={IconListDetails}
        label={t("display.gatherText")}
        onClick={props.onOpenTextView}
      />
      <QuickControl
        disabled={!props.chapterAvailable}
        Icon={IconBook2}
        label={t("display.styleGuide")}
        onClick={props.onOpenStyleGuide}
      />
    </div>
  );
}

function QuickControl({
  active,
  disabled,
  Icon,
  label,
  onClick,
}: {
  active?: boolean;
  disabled?: boolean;
  Icon: TablerIcon;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <ControlTooltip
      className="stage-toolbar-control chapter-quick-control"
      content={label}
      placement="left"
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={active === undefined ? undefined : active}
        className={`stage-toolbar-button ${active ? "active" : ""}`.trim()}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon size={22} stroke={2.1} aria-hidden="true" />
      </button>
    </ControlTooltip>
  );
}
