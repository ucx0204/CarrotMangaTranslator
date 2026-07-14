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
  brushColor: string;
  brushRadius: number;
  currentChapter: ChapterSnapshot | null;
  flowActive: boolean;
  jobActive: boolean;
  jobState: JobState;
  maskStrokeCount: number;
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
  onRunDrawnPattern: () => void;
  onRunCurrentPageInpainting: () => void;
  onShowGuide: () => void;
  onOpenAutoInpaintingOptions: () => void;
  onToggleBlocks: () => void;
  onToggleChrome: () => void;
};

export function UnifiedRightRail(
  props: UnifiedRightRailProps,
): React.JSX.Element {
  return (
    <>
      <RunPanel
        currentChapter={props.currentChapter}
        hasSelectedPage={Boolean(props.selectedPage)}
        flowActive={props.flowActive}
        jobActive={props.jobActive}
        jobState={props.jobState}
        onCancelJob={props.onCancelJob}
        onOpenExport={props.onOpenExport}
        onOpenTranslateOptions={props.onOpenTranslateOptions}
        onOpenAutoInpaintingOptions={props.onOpenAutoInpaintingOptions}
        onRunCurrentPageInpainting={props.onRunCurrentPageInpainting}
        onShowGuide={props.onShowGuide}
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
  if (props.selectedBlock) {
    return <EditorPanelSlot />;
  }
  return (
    <StatusPanel jobState={props.jobState} statusLines={props.statusLines} />
  );
}
