import React from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { isRetouchTool, type WorkspaceTool } from "../lib/stageTool";
import { EditorPanelSlot } from "../panels/EditorPanelSlot";
import {
  DisplayControlPanel,
  InpaintingControlPanel,
} from "./InpaintingControlPanel";
import { RunPanel, StatusPanel } from "./RunStatusPanels";

export type UnifiedRightRailProps = {
  autoInpaintingOpen: boolean;
  brushColor: string;
  brushRadius: number;
  canRedoRetouch: boolean;
  canUndoRetouch: boolean;
  currentChapter: ChapterSnapshot | null;
  flowActive: boolean;
  inpaintedPageCount: number;
  jobActive: boolean;
  jobState: JobState;
  maskStrokeCount: number;
  pageTargetCount: number;
  peekAvailable: boolean;
  peeking: boolean;
  pendingPageCount: number;
  pendingTargetCount: number;
  progressSnapshot: ProgressSnapshot | null;
  selectedBlock: TranslationBlock | null;
  selectedPage: MangaPage | null;
  showBlockChrome: boolean;
  showProgressBar: boolean;
  showTextBlocks: boolean;
  stageTool: WorkspaceTool;
  statusLines: string[];
  onBrushColorChange: (value: string) => void;
  onBrushRadiusChange: (value: number) => void;
  onCancelJob: () => void;
  onClearPatternMask: () => void;
  onOpenExport: () => void;
  onOpenStyleGuide: () => void;
  onOpenTextView: () => void;
  onOpenTranslateOptions: () => void;
  onPeekToggle: () => void;
  onRedoRetouch: () => void;
  onRevertChapter: () => void;
  onRevertPage: () => void;
  onRunDrawnPattern: () => void;
  onShowGuide: () => void;
  onOpenAutoInpaintingOptions: () => void;
  onToggleBlocks: () => void;
  onToggleChrome: () => void;
  onUndoRetouch: () => void;
};

export function UnifiedRightRail(
  props: UnifiedRightRailProps,
): React.JSX.Element {
  return (
    <>
      <RunPanel
        autoInpaintingOpen={props.autoInpaintingOpen}
        currentChapter={props.currentChapter}
        flowActive={props.flowActive}
        jobActive={props.jobActive}
        jobState={props.jobState}
        onCancelJob={props.onCancelJob}
        onOpenExport={props.onOpenExport}
        onOpenTranslateOptions={props.onOpenTranslateOptions}
        onOpenAutoInpaintingOptions={props.onOpenAutoInpaintingOptions}
        progressSnapshot={props.progressSnapshot}
        showProgressBar={props.showProgressBar}
      />
      <DisplayControlPanel
        showBlockChrome={props.showBlockChrome}
        showTextBlocks={props.showTextBlocks}
        canOpenTextView={Boolean(props.currentChapter)}
        onToggleChrome={props.onToggleChrome}
        onToggleBlocks={props.onToggleBlocks}
        onOpenTextView={props.onOpenTextView}
        onOpenStyleGuide={props.onOpenStyleGuide}
      />
      <ContextualRightRailPanel {...props} />
    </>
  );
}

function ContextualRightRailPanel(
  props: UnifiedRightRailProps,
): React.JSX.Element {
  if (isRetouchTool(props.stageTool)) {
    return (
      <InpaintingControlPanel
        brushColor={props.brushColor}
        brushRadius={props.brushRadius}
        canRedo={props.canRedoRetouch}
        canUndo={props.canUndoRetouch}
        hasSelectedPage={Boolean(props.selectedPage)}
        jobActive={props.jobActive}
        jobState={props.jobState}
        maskStrokeCount={props.maskStrokeCount}
        mode="retouch"
        onBrushColorChange={props.onBrushColorChange}
        onBrushRadiusChange={props.onBrushRadiusChange}
        onCancelJob={props.onCancelJob}
        onClearPatternMask={props.onClearPatternMask}
        onRedoRetouch={props.onRedoRetouch}
        onRunDrawnPattern={props.onRunDrawnPattern}
        onUndoRetouch={props.onUndoRetouch}
        progressSnapshot={props.progressSnapshot}
        tool={props.stageTool}
      />
    );
  }
  if (props.autoInpaintingOpen) {
    return (
      <InpaintingControlPanel
        currentChapter={props.currentChapter}
        inpaintedPageCount={props.inpaintedPageCount}
        jobActive={props.jobActive}
        jobState={props.jobState}
        mode="auto"
        onCancelJob={props.onCancelJob}
        onPeekToggle={props.onPeekToggle}
        onRevertChapter={props.onRevertChapter}
        onRevertPage={props.onRevertPage}
        onShowGuide={props.onShowGuide}
        pageTargetCount={props.pageTargetCount}
        peekAvailable={props.peekAvailable}
        peeking={props.peeking}
        pendingPageCount={props.pendingPageCount}
        pendingTargetCount={props.pendingTargetCount}
        progressSnapshot={props.progressSnapshot}
        selectedPage={props.selectedPage}
      />
    );
  }
  if (props.selectedBlock) {
    return <EditorPanelSlot />;
  }
  return (
    <StatusPanel jobState={props.jobState} statusLines={props.statusLines} />
  );
}
