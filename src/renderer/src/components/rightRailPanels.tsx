import React from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import type { AutoInpaintingEntryScope } from "../lib/autoInpaintingSelection";
import { isRetouchTool, type WorkspaceTool } from "../lib/stageTool";
import { EditorPanelSlot } from "../panels/EditorPanelSlot";
import { InpaintingControlPanel } from "./InpaintingControlPanel";
import { ChapterTaskHub } from "./RunStatusPanels";
import { PageBlockListPanel } from "./PageBlockListPanel";
import type { RightRailMode } from "../app/session/useAppSessionUiState";
import type { BlockReadingDirection } from "../../../shared/blockReadingOrder";
import type { ChapterSaveStatus } from "../hooks/chapterPersistenceTypes";
import type { LinkedWorkspaceStatus } from "../../../shared/linkedWorkspaceTypes";

export type UnifiedRightRailProps = {
  brushColor: string;
  brushRadius: number;
  canRedo: boolean;
  canUndo: boolean;
  compareAvailable: boolean;
  currentChapter: ChapterSnapshot | null;
  flowActive: boolean;
  editorDisabled: boolean;
  jobActive: boolean;
  jobState: JobState;
  maskStrokeCount: number;
  linkedWorkspaceStatus?: LinkedWorkspaceStatus | null;
  linkedWorkspaceViewBusy?: boolean;
  peeking: boolean;
  progressSnapshot: ProgressSnapshot | null;
  redoLabel?: string | null;
  resetAvailable: boolean;
  selectedBlock: TranslationBlock | null;
  selectedBlockId: string | null;
  selectedBlockIds?: string[];
  selectedPage: MangaPage | null;
  rightRailMode: RightRailMode;
  saveStatus: ChapterSaveStatus;
  blockReadingDirection: BlockReadingDirection;
  canRunBubbleLayout: boolean;
  showBlockChrome: boolean;
  showProgressBar: boolean;
  showTextBlocks: boolean;
  stageTool: WorkspaceTool;
  statusLines: string[];
  undoLabel?: string | null;
  onBrushColorChange: (value: string) => void;
  onBrushRadiusChange: (value: number) => void;
  onAdjustPatternMask?: (deltaPx: number) => void;
  onCancelJob: () => void;
  onClearStatusLines: () => void;
  onClearPatternMask: () => void;
  onOpenExport: () => void;
  onOpenPsdExport?: () => void;
  onViewLinkedResults?: () => void;
  onOpenLogFolder: () => void;
  onReviewResults: () => void;
  onRetryPage: (pageId: string) => void;
  onOpenStyleGuide: () => void;
  onOpenTextView: () => void;
  onOpenTranslateOptions: () => void;
  onOpenBlockEditor: (blockId: string) => void;
  onPeekToggle: () => void;
  onRedo: () => void;
  onResetPage: () => void;
  onRunDrawnPattern: () => void;
  onRunBubbleLayout: () => void;
  onRetrySave: () => void;
  onToggleBlocks: () => void;
  onToggleChrome: () => void;
  onUndo: () => void;
  onSelectBlock: (blockId: string) => void;
  onChangeBlockSelection?: (
    blockIds: string[],
    primaryBlockId: string | null,
  ) => void;
  onMoveBlockInReadingOrder?: (blockId: string, direction: -1 | 1) => void;
  onSortReadingOrder?: () => void;
  onUpdateBlock: (blockId: string, patch: Partial<TranslationBlock>) => void;
  onOpenAutoInpaintingOptions: (scope: AutoInpaintingEntryScope) => void;
};

export function UnifiedRightRail(
  props: UnifiedRightRailProps,
): React.JSX.Element {
  return (
    <>
      {props.currentChapter ? (
        <ChapterTaskHub
          currentChapter={props.currentChapter}
          canRunBubbleLayout={props.canRunBubbleLayout}
          hasSelectedPage={Boolean(props.selectedPage)}
          flowActive={props.flowActive}
          jobActive={props.jobActive}
          saveStatus={props.saveStatus}
          onOpenExport={props.onOpenExport}
          onOpenPsdExport={props.onOpenPsdExport ?? NOOP}
          onOpenTranslateOptions={props.onOpenTranslateOptions}
          onOpenAutoInpaintingOptions={props.onOpenAutoInpaintingOptions}
          onRunBubbleLayout={props.onRunBubbleLayout}
          onRetrySave={props.onRetrySave}
          linkedWorkspaceStatus={props.linkedWorkspaceStatus ?? null}
          linkedWorkspaceViewBusy={props.linkedWorkspaceViewBusy ?? false}
          onViewLinkedResults={props.onViewLinkedResults ?? NOOP}
        />
      ) : null}
      <ContextualRightRailPanel {...props} />
    </>
  );
}

function ContextualRightRailPanel(
  props: UnifiedRightRailProps,
): React.JSX.Element | null {
  if (isRetouchTool(props.stageTool)) {
    return (
      <InpaintingControlPanel
        brushColor={props.brushColor}
        brushRadius={props.brushRadius}
        hasSelectedPage={Boolean(props.selectedPage)}
        jobActive={props.jobActive}
        jobState={props.jobState}
        maskStrokeCount={props.maskStrokeCount}
        mode="retouch"
        onBrushColorChange={props.onBrushColorChange}
        onBrushRadiusChange={props.onBrushRadiusChange}
        onAdjustPatternMask={props.onAdjustPatternMask ?? NOOP_ADJUST_MASK}
        onCancelJob={props.onCancelJob}
        onClearPatternMask={props.onClearPatternMask}
        onRunDrawnPattern={props.onRunDrawnPattern}
        progressSnapshot={props.progressSnapshot}
        tool={props.stageTool}
      />
    );
  }
  if (props.rightRailMode === "block-editor" && props.selectedBlock) {
    return <EditorPanelSlot />;
  }
  if (props.selectedPage) {
    return (
      <PageBlockListPanel
        disabled={props.editorDisabled}
        page={props.selectedPage}
        readingDirection={props.blockReadingDirection}
        selectedBlockId={props.selectedBlockId}
        selectedBlockIds={props.selectedBlockIds ?? []}
        onChangeSelection={props.onChangeBlockSelection}
        onMoveBlock={props.onMoveBlockInReadingOrder}
        onOpenEditor={props.onOpenBlockEditor}
        onSelectBlock={props.onSelectBlock}
        onSortReadingOrder={props.onSortReadingOrder}
        onUpdateBlock={props.onUpdateBlock}
      />
    );
  }
  return null;
}

const NOOP = (): void => undefined;
const NOOP_ADJUST_MASK = (): void => undefined;
