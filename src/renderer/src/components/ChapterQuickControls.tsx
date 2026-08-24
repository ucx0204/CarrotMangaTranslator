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
import { IconButton } from "./ui/IconButton";

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
  const labels = useQuickControlLabels(props);
  return (
    <div
      className="chapter-quick-controls"
      id={props.id}
      role="toolbar"
      aria-label={labels.toolbar}
    >
      <QuickControlGroup name="history">
        <QuickControl
          disabled={props.disabled || !props.canUndo}
          Icon={IconArrowBackUp}
          label={labels.undo}
          onClick={props.onUndo}
        />
        <QuickControl
          disabled={props.disabled || !props.canRedo}
          Icon={IconArrowForwardUp}
          label={labels.redo}
          onClick={props.onRedo}
        />
      </QuickControlGroup>
      <QuickControlGroup name="original">
        <QuickControl
          active={props.peeking}
          disabled={props.disabled || !props.compareAvailable}
          Icon={props.peeking ? IconEyeOff : IconEye}
          label={labels.compare}
          onClick={props.onPeekToggle}
        />
        <QuickControl
          disabled={props.disabled || !props.resetAvailable}
          Icon={IconRestore}
          label={labels.reset}
          onClick={props.onResetPage}
        />
      </QuickControlGroup>
      <QuickControlGroup name="display">
        <QuickControl
          active={props.showTextBlocks}
          Icon={IconSquareLetterT}
          label={labels.translations}
          onClick={props.onToggleBlocks}
        />
        <QuickControl
          active={props.showBlockChrome}
          Icon={IconBorderAll}
          label={labels.chrome}
          onClick={props.onToggleChrome}
        />
      </QuickControlGroup>
      <QuickControlGroup name="documents">
        <QuickControl
          disabled={!props.chapterAvailable}
          Icon={IconListDetails}
          label={labels.gatherText}
          onClick={props.onOpenTextView}
        />
        <QuickControl
          disabled={!props.chapterAvailable}
          Icon={IconBook2}
          label={labels.styleGuide}
          onClick={props.onOpenStyleGuide}
        />
      </QuickControlGroup>
    </div>
  );
}

function useQuickControlLabels(props: ChapterQuickControlsProps) {
  const { t } = useTranslation("components");
  return {
    chrome: t("workspaceActions.showEditingChrome"),
    compare: t(
      props.peeking
        ? "workspaceActions.hideOriginal"
        : "workspaceActions.compareOriginal",
    ),
    gatherText: t("display.gatherText"),
    redo: formatShortcutTextForPlatform(
      props.redoLabel
        ? t("workspaceActions.redoNamed", { action: props.redoLabel })
        : t("workspaceActions.redo"),
    ),
    reset: t("workspaceActions.resetPageTitle"),
    styleGuide: t("display.styleGuide"),
    toolbar: t("workspaceActions.label"),
    translations: t("workspaceActions.showTranslations"),
    undo: formatShortcutTextForPlatform(
      props.undoLabel
        ? t("workspaceActions.undoNamed", { action: props.undoLabel })
        : t("workspaceActions.undo"),
    ),
  };
}

function QuickControlGroup({
  children,
  name,
}: {
  children: React.ReactNode;
  name: "history" | "original" | "display" | "documents";
}): React.JSX.Element {
  return (
    <div className="chapter-quick-group" data-chapter-quick-group={name}>
      {children}
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
      <IconButton
        variant="canvas"
        size="lg"
        label={label}
        title=""
        aria-pressed={active === undefined ? undefined : active}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon size={22} stroke={2.1} aria-hidden="true" />
      </IconButton>
    </ControlTooltip>
  );
}
