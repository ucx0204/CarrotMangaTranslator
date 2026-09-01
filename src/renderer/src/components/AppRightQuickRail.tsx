import React from "react";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { UnifiedRightRailProps } from "./rightRailPanels";
import { ChapterQuickControls } from "./ChapterQuickControls";
import { StatusDockButton } from "./StatusDockButton";
import {
  WorkspaceViewControls,
  type WorkspaceViewControlsProps,
} from "./WorkspaceViewControls";
import {
  WorkspaceOriginalOpacityControl,
  type WorkspaceOriginalOpacityControlProps,
} from "./WorkspaceOriginalOpacityControl";
import { ControlTooltip } from "./ui/ControlTooltip";
import { IconButton } from "./ui/IconButton";

export type AppRightQuickRailProps = Pick<
  UnifiedRightRailProps,
  | "canRedo"
  | "canUndo"
  | "compareAvailable"
  | "completionSoundMuted"
  | "completionSoundVolume"
  | "completionSoundTranslationMuted"
  | "completionSoundSoundEffectMuted"
  | "completionSoundSourceErasingMuted"
  | "completionSoundResearchMuted"
  | "currentChapter"
  | "flowActive"
  | "jobActive"
  | "jobState"
  | "operationActivity"
  | "onCancelJob"
  | "onCancelOperation"
  | "onOpenExport"
  | "onOpenErrorReport"
  | "onOpenStyleGuide"
  | "onOpenTextView"
  | "onClearStatusLines"
  | "onCompletionSoundChange"
  | "onPeekToggle"
  | "onRedo"
  | "onResetPage"
  | "onReviewResults"
  | "onRetryPage"
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
  | "statusEntries"
  | "statusLines"
  | "undoLabel"
> & {
  workspaceOriginalOpacityControl: WorkspaceOriginalOpacityControlProps;
  workspaceViewControls: WorkspaceViewControlsProps;
};

/**
 * Mirror the left stage toolbar from the right edge of the canvas. Both tool
 * groups float over the pasteboard so neither changes the page centre.
 */
export function AppRightQuickRail(
  props: AppRightQuickRailProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const controlsId = React.useId();
  const disabled = !props.currentChapter || props.jobActive || props.flowActive;
  const [topCollapsed, setTopCollapsed] = React.useState(false);
  const [bottomCollapsed, setBottomCollapsed] = React.useState(false);

  return (
    <aside className="right-quick-rail">
      <TopQuickRailGroup
        collapsed={topCollapsed}
        controlsId={controlsId}
        disabled={disabled}
        label={t(
          topCollapsed
            ? "workspace.quickRail.showTop"
            : "workspace.quickRail.hideTop",
        )}
        quickRailProps={props}
        onToggle={() => setTopCollapsed((collapsed) => !collapsed)}
      />
      <BottomQuickRailGroup
        collapsed={bottomCollapsed}
        label={t(
          bottomCollapsed
            ? "workspace.quickRail.showBottom"
            : "workspace.quickRail.hideBottom",
        )}
        quickRailProps={props}
        onToggle={() => setBottomCollapsed((collapsed) => !collapsed)}
      />
    </aside>
  );
}

function TopQuickRailGroup({
  collapsed,
  controlsId,
  disabled,
  label,
  quickRailProps: props,
  onToggle,
}: {
  collapsed: boolean;
  controlsId: string;
  disabled: boolean;
  label: string;
  quickRailProps: AppRightQuickRailProps;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <div className="right-quick-rail-top">
      <div
        className={`chapter-quick-controls-frame right-quick-controls-frame ${collapsed ? "collapsed" : ""}`.trim()}
      >
        {!collapsed ? (
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
        ) : null}
        <QuickRailGroupToggle
          collapsed={collapsed}
          label={label}
          onToggle={onToggle}
        />
      </div>
    </div>
  );
}

function BottomQuickRailGroup({
  collapsed,
  label,
  quickRailProps: props,
  onToggle,
}: {
  collapsed: boolean;
  label: string;
  quickRailProps: AppRightQuickRailProps;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <div className="right-quick-rail-bottom">
      <div
        className={`right-quick-controls-frame right-quick-bottom-frame ${collapsed ? "collapsed" : ""}`.trim()}
      >
        {!collapsed ? <BottomQuickRailControls {...props} /> : null}
        <QuickRailGroupToggle
          collapsed={collapsed}
          label={label}
          onToggle={onToggle}
        />
      </div>
    </div>
  );
}

function BottomQuickRailControls(
  props: AppRightQuickRailProps,
): React.JSX.Element {
  const failedPages =
    props.currentChapter?.pages
      .filter((page) => page.analysisStatus === "failed")
      .map((page) => ({
        id: page.id,
        name: page.name,
        error: page.lastError,
      })) ?? [];
  return (
    <div className="right-quick-rail-bottom-controls">
      <div className="right-quick-bottom-group" data-right-quick-group="view">
        <WorkspaceViewControls {...props.workspaceViewControls} />
      </div>
      <div
        className="right-quick-bottom-group"
        data-right-quick-group="original-opacity"
      >
        <WorkspaceOriginalOpacityControl
          {...props.workspaceOriginalOpacityControl}
        />
      </div>
      <div className="right-quick-bottom-group" data-right-quick-group="status">
        <StatusDockButton
          completionSoundMuted={props.completionSoundMuted}
          completionSoundVolume={props.completionSoundVolume}
          completionSoundTranslationMuted={
            props.completionSoundTranslationMuted
          }
          completionSoundSoundEffectMuted={
            props.completionSoundSoundEffectMuted
          }
          completionSoundSourceErasingMuted={
            props.completionSoundSourceErasingMuted
          }
          completionSoundResearchMuted={props.completionSoundResearchMuted}
          jobState={props.jobState}
          operationActivity={props.operationActivity}
          progressSnapshot={props.progressSnapshot}
          showProgressBar={props.showProgressBar}
          statusEntries={props.statusEntries}
          statusLines={props.statusLines}
          failedPages={failedPages}
          onCancelJob={props.onCancelJob}
          onCancelOperation={props.onCancelOperation}
          onClear={props.onClearStatusLines}
          onCompletionSoundChange={props.onCompletionSoundChange}
          onOpenExport={props.onOpenExport}
          onOpenErrorReport={props.onOpenErrorReport}
          onReviewResults={props.onReviewResults}
          onRetryPage={props.onRetryPage}
        />
      </div>
    </div>
  );
}

function QuickRailGroupToggle({
  collapsed,
  label,
  onToggle,
}: {
  collapsed: boolean;
  label: string;
  onToggle: () => void;
}): React.JSX.Element {
  const Icon = collapsed ? IconChevronLeft : IconChevronRight;
  return (
    <ControlTooltip
      className="right-quick-rail-toggle"
      content={label}
      placement="left"
    >
      <IconButton
        variant="canvas"
        aria-pressed={collapsed}
        label={label}
        title=""
        onClick={onToggle}
      >
        <Icon size={20} stroke={2.2} aria-hidden="true" />
      </IconButton>
    </ControlTooltip>
  );
}
