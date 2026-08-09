import React from "react";
import type { UnifiedRightRailProps } from "./rightRailPanels";
import { ChapterQuickControls } from "./ChapterQuickControls";
import { StatusDockButton } from "./StatusDockButton";

export type AppRightQuickRailProps = Pick<
  UnifiedRightRailProps,
  | "canRedo"
  | "canUndo"
  | "compareAvailable"
  | "currentChapter"
  | "flowActive"
  | "jobActive"
  | "jobState"
  | "onCancelJob"
  | "onOpenExport"
  | "onOpenStyleGuide"
  | "onOpenTextView"
  | "onClearStatusLines"
  | "onPeekToggle"
  | "onRedo"
  | "onResetPage"
  | "onReviewResults"
  | "onToggleBlocks"
  | "onToggleChrome"
  | "onUndo"
  | "peeking"
  | "progressSnapshot"
  | "redoLabel"
  | "resetAvailable"
  | "showBlockChrome"
  | "showTextBlocks"
  | "showProgressBar"
  | "statusLines"
  | "undoLabel"
>;

/**
 * Page-wide actions live in their own strip between the canvas and inspector.
 * Keeping this outside both surfaces prevents controls from covering artwork
 * or consuming the narrow task-card content width.
 */
export function AppRightQuickRail(
  props: AppRightQuickRailProps,
): React.JSX.Element {
  const controlsId = React.useId();
  const disabled = !props.currentChapter || props.jobActive || props.flowActive;

  return (
    <aside className="right-quick-rail">
      <div className="chapter-quick-controls-frame">
        <ChapterQuickControls
          canRedo={props.canRedo}
          canUndo={props.canUndo}
          chapterAvailable={Boolean(props.currentChapter)}
          compareAvailable={props.compareAvailable}
          disabled={disabled}
          id={controlsId}
          peeking={props.peeking}
          redoLabel={props.redoLabel}
          resetAvailable={props.resetAvailable}
          showBlockChrome={props.showBlockChrome}
          showTextBlocks={props.showTextBlocks}
          undoLabel={props.undoLabel}
          onOpenStyleGuide={props.onOpenStyleGuide}
          onOpenTextView={props.onOpenTextView}
          onPeekToggle={props.onPeekToggle}
          onRedo={props.onRedo}
          onResetPage={props.onResetPage}
          onToggleBlocks={props.onToggleBlocks}
          onToggleChrome={props.onToggleChrome}
          onUndo={props.onUndo}
        />
      </div>
      <StatusDockButton
        jobState={props.jobState}
        progressSnapshot={props.progressSnapshot}
        showProgressBar={props.showProgressBar}
        statusLines={props.statusLines}
        onCancelJob={props.onCancelJob}
        onClear={props.onClearStatusLines}
        onOpenExport={props.onOpenExport}
        onReviewResults={props.onReviewResults}
      />
    </aside>
  );
}
