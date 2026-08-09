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
  peeking: boolean;
  progressSnapshot: ProgressSnapshot | null;
  redoLabel?: string | null;
  resetAvailable: boolean;
  selectedBlock: TranslationBlock | null;
  selectedBlockId: string | null;
  selectedPage: MangaPage | null;
  rightRailMode: RightRailMode;
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
  onCancelJob: () => void;
  onClearStatusLines: () => void;
  onClearPatternMask: () => void;
  onOpenExport: () => void;
  onOpenStyleGuide: () => void;
  onOpenTextView: () => void;
  onOpenTranslateOptions: () => void;
  onOpenBlockEditor: (blockId: string) => void;
  onPeekToggle: () => void;
  onRedo: () => void;
  onResetPage: () => void;
  onRunDrawnPattern: () => void;
  onRunBubbleLayout: () => void;
  onRunCurrentPageInpainting: () => void;
  onToggleBlocks: () => void;
  onToggleChrome: () => void;
  onUndo: () => void;
  onSelectBlock: (blockId: string) => void;
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
          onOpenExport={props.onOpenExport}
          onOpenTranslateOptions={props.onOpenTranslateOptions}
          onOpenAutoInpaintingOptions={props.onOpenAutoInpaintingOptions}
          onRunCurrentPageInpainting={props.onRunCurrentPageInpainting}
          onRunBubbleLayout={props.onRunBubbleLayout}
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
        onOpenEditor={props.onOpenBlockEditor}
        onSelectBlock={props.onSelectBlock}
        onUpdateBlock={props.onUpdateBlock}
      />
    );
  }
  return null;
}
