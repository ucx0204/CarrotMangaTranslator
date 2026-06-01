import React from "react";
import type { ChapterSnapshot, JobState, MangaPage, TranslationBlock } from "../../../shared/types";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { EditorPanel } from "./EditorPanel";
import {
  DisplayControlPanel,
  InpaintingControlPanel,
  type BlockCounts,
  type InpaintingStage,
  type InpaintingTool
} from "./InpaintingControlPanel";
import { RunPanel, StatusPanel } from "./RunStatusPanels";

type AppRightRailProps = {
  inpaintingMode: boolean;
  inpaintingStage: InpaintingStage;
  currentChapter: ChapterSnapshot | null;
  selectedPage: MangaPage | null;
  selectedBlock: TranslationBlock | null;
  selectedPageImageDataUrl: string;
  selectedPageEditLocked: boolean;
  blockCounts: BlockCounts;
  inpaintedPageCount: number;
  inpaintingTool: InpaintingTool;
  inpaintingBrushRadius: number;
  inpaintingPaintColor: string;
  patternMaskStrokeCount: number;
  canUndoRetouch: boolean;
  canRedoRetouch: boolean;
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  showProgressBar: boolean;
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  jobActive: boolean;
  statusLines: string[];
  areaTranslateSelecting: boolean;
  onSelectInpaintingTool: (tool: InpaintingTool) => void;
  onBrushRadiusChange: (radius: number) => void;
  onBrushColorChange: (color: string) => void;
  onUndoRetouch: () => void;
  onRedoRetouch: () => void;
  onRevertPage: () => void;
  onRevertChapter: () => void;
  onRunInpaintingPage: () => void;
  onRunInpaintingChapter: () => void;
  onRunDrawnPattern: () => void;
  onClearPatternMask: () => void;
  onShowInpaintingGuide: () => void;
  onToggleChrome: () => void;
  onToggleBlocks: () => void;
  onExportResults: () => void;
  onGoToNextInpaintingStage: () => void;
  onRunPending: () => void;
  onRunAll: () => void;
  onEnterInpainting: () => void;
  onCancelJob: () => void;
  onStartAreaTranslate: () => void;
  onUpdateBlock: (patch: Partial<TranslationBlock>) => void;
  onDeleteBlock: () => void;
  onDuplicateBlock: () => void;
};

export function AppRightRail({
  inpaintingMode,
  inpaintingStage,
  currentChapter,
  selectedPage,
  selectedBlock,
  selectedPageImageDataUrl,
  selectedPageEditLocked,
  blockCounts,
  inpaintedPageCount,
  inpaintingTool,
  inpaintingBrushRadius,
  inpaintingPaintColor,
  patternMaskStrokeCount,
  canUndoRetouch,
  canRedoRetouch,
  jobState,
  progressSnapshot,
  showProgressBar,
  showBlockChrome,
  showTextBlocks,
  jobActive,
  statusLines,
  areaTranslateSelecting,
  onSelectInpaintingTool,
  onBrushRadiusChange,
  onBrushColorChange,
  onUndoRetouch,
  onRedoRetouch,
  onRevertPage,
  onRevertChapter,
  onRunInpaintingPage,
  onRunInpaintingChapter,
  onRunDrawnPattern,
  onClearPatternMask,
  onShowInpaintingGuide,
  onToggleChrome,
  onToggleBlocks,
  onExportResults,
  onGoToNextInpaintingStage,
  onRunPending,
  onRunAll,
  onEnterInpainting,
  onCancelJob,
  onStartAreaTranslate,
  onUpdateBlock,
  onDeleteBlock,
  onDuplicateBlock
}: AppRightRailProps): React.JSX.Element {
  const editorDisabled = selectedPageEditLocked || jobActive;

  return (
    <aside className={`right-rail ${inpaintingMode ? "inpainting-rail" : ""}`}>
      {inpaintingMode ? (
        <>
          <InpaintingControlPanel
            stage={inpaintingStage}
            currentChapter={currentChapter}
            selectedPage={selectedPage}
            selectedBlock={selectedBlock}
            blockCounts={blockCounts}
            inpaintedPageCount={inpaintedPageCount}
            tool={inpaintingTool}
            brushRadius={inpaintingBrushRadius}
            brushColor={inpaintingPaintColor}
            maskStrokeCount={patternMaskStrokeCount}
            canUndo={canUndoRetouch}
            canRedo={canRedoRetouch}
            jobState={jobState}
            progressSnapshot={progressSnapshot}
            showBlockChrome={showBlockChrome}
            showTextBlocks={showTextBlocks}
            jobActive={jobActive}
            onSelectTool={onSelectInpaintingTool}
            onBrushRadiusChange={onBrushRadiusChange}
            onBrushColorChange={onBrushColorChange}
            onUndoRetouch={onUndoRetouch}
            onRedoRetouch={onRedoRetouch}
            onRevertPage={onRevertPage}
            onRevertChapter={onRevertChapter}
            onRunPage={onRunInpaintingPage}
            onRunChapter={onRunInpaintingChapter}
            onRunDrawnPattern={onRunDrawnPattern}
            onClearPatternMask={onClearPatternMask}
            onShowGuide={onShowInpaintingGuide}
            onToggleChrome={onToggleChrome}
            onToggleBlocks={onToggleBlocks}
            onExportResults={onExportResults}
          />
          {inpaintingStage === "finalize" ? (
            <EditorPanel
              block={selectedBlock}
              disabled={editorDisabled}
              onUpdate={onUpdateBlock}
              onDelete={onDeleteBlock}
              onDuplicate={onDuplicateBlock}
            />
          ) : null}
          <section className="inpainting-next-panel">
            <button
              className={inpaintingStage === "pattern" ? "pattern-next-button" : "primary"}
              onClick={onGoToNextInpaintingStage}
              disabled={jobActive || inpaintingStage === "review"}
            >
              {inpaintingStage === "pattern" ? "최종 처리로 넘어가기" : inpaintingStage === "finalize" ? "결과 확인" : "완료"}
            </button>
          </section>
        </>
      ) : (
        <>
          <RunPanel
            currentChapter={currentChapter}
            jobActive={jobActive}
            showProgressBar={showProgressBar}
            progressSnapshot={progressSnapshot}
            jobState={jobState}
            onRunPending={onRunPending}
            onRunAll={onRunAll}
            onEnterInpainting={onEnterInpainting}
            onCancelJob={onCancelJob}
          />

          <DisplayControlPanel showBlockChrome={showBlockChrome} showTextBlocks={showTextBlocks} onToggleChrome={onToggleChrome} onToggleBlocks={onToggleBlocks} />

          {!selectedBlock ? <StatusPanel jobState={jobState} statusLines={statusLines} /> : null}

          <EditorPanel
            block={selectedBlock}
            disabled={editorDisabled}
            areaTranslateAvailable={Boolean(selectedPage && selectedPageImageDataUrl && !jobActive)}
            areaTranslateSelecting={areaTranslateSelecting}
            onStartAreaTranslate={onStartAreaTranslate}
            onUpdate={onUpdateBlock}
            onDelete={onDeleteBlock}
            onDuplicate={onDuplicateBlock}
          />
        </>
      )}
    </aside>
  );
}
