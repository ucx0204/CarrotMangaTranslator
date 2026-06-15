import React from "react";
import { useInpainting } from "../inpainting/useInpainting";
import { AutoInpaintingStep } from "./inpaintingPanel/AutoInpaintingStep";
import { ExportInpaintingStep } from "./inpaintingPanel/ExportInpaintingStep";
import { InpaintingFlowHeader } from "./inpaintingPanel/InpaintingFlowHeader";
import { InpaintingProgressCard } from "./inpaintingPanel/InpaintingProgressCard";
import { RetouchInpaintingStep } from "./inpaintingPanel/RetouchInpaintingStep";
import type { FlowStep } from "./inpaintingPanel/inpaintingPanelTypes";

export { DisplayControlPanel } from "./inpaintingPanel/DisplayControlPanel";

export function InpaintingControlPanel(): React.JSX.Element {
  const {
    currentChapter,
    selectedPage,
    blockCounts,
    inpaintedPageCount,
    tool,
    brushRadius,
    brushColor,
    maskStrokeCount,
    canUndo,
    canRedo,
    jobState,
    progressSnapshot,
    showBlockChrome,
    showTextBlocks,
    jobActive,
    peekAvailable,
    peeking,
    onSelectTool,
    onBrushRadiusChange,
    onBrushColorChange,
    onUndoRetouch,
    onRedoRetouch,
    onRevertPage,
    onRevertChapter,
    onRunPage,
    onRunChapter,
    onRunDrawnPattern,
    onClearPatternMask,
    onShowGuide,
    onPeekToggle,
    onToggleChrome,
    onToggleBlocks,
    onExportResults,
    onCancelJob,
  } = useInpainting();
  const [step, setStep] = React.useState<FlowStep>("auto");

  const goToStep = React.useCallback(
    (next: FlowStep): void => {
      setStep(next);
      if (next !== "retouch") {
        onSelectTool("none");
      }
    },
    [onSelectTool],
  );

  const activeInpaintingJob =
    jobState.kind === "inpainting" && jobState.status !== "idle";
  const totalPages = currentChapter?.pages.length ?? 0;
  const pageTargetCount = blockCounts.selectedPage;
  const pendingTargetCount = blockCounts.pendingTotal;
  const activeToolLabel =
    tool === "mask"
      ? "마스크 붓"
      : tool === "brush"
        ? "붓"
        : tool === "eraser"
          ? "복원"
          : tool === "picker"
            ? "색 뽑기"
            : "도구를 선택하세요";
  const sizableTool = tool === "mask" || tool === "brush" || tool === "eraser";

  return (
    <section className="inpainting-panel inpaint-flow">
      <InpaintingFlowHeader
        onShowGuide={onShowGuide}
        onStepChange={goToStep}
        onToggleBlocks={onToggleBlocks}
        onToggleChrome={onToggleChrome}
        showBlockChrome={showBlockChrome}
        showTextBlocks={showTextBlocks}
        step={step}
      />

      <div className="inpainting-counts">
        <span className="type-stat nonsolid">이 페이지 {pageTargetCount}</span>
        <span className="type-stat nonsolid">남은 {pendingTargetCount}</span>
        <span className="type-stat review">완료 {inpaintedPageCount}</span>
      </div>

      {activeInpaintingJob ? (
        <InpaintingProgressCard
          jobState={jobState}
          progressSnapshot={progressSnapshot}
          onCancel={onCancelJob}
        />
      ) : null}

      {step === "auto" ? (
        <AutoInpaintingStep
          hasCurrentChapter={Boolean(currentChapter)}
          hasSelectedPage={Boolean(selectedPage)}
          inpaintedPageCount={inpaintedPageCount}
          jobActive={jobActive}
          onGoToRetouch={() => goToStep("retouch")}
          onPeekToggle={onPeekToggle}
          onRevertChapter={onRevertChapter}
          onRevertPage={onRevertPage}
          onRunChapter={onRunChapter}
          onRunPage={onRunPage}
          pageTargetCount={pageTargetCount}
          peekAvailable={peekAvailable}
          peeking={peeking}
          pendingPages={blockCounts.pendingPages}
          pendingTargetCount={pendingTargetCount}
          selectedPageInpainted={Boolean(selectedPage?.inpaintedImagePath)}
          totalPages={totalPages}
        />
      ) : null}

      {step === "retouch" ? (
        <RetouchInpaintingStep
          activeToolLabel={activeToolLabel}
          brushColor={brushColor}
          brushRadius={brushRadius}
          canRedo={canRedo}
          canUndo={canUndo}
          hasSelectedPage={Boolean(selectedPage)}
          jobActive={jobActive}
          maskStrokeCount={maskStrokeCount}
          onBrushColorChange={onBrushColorChange}
          onBrushRadiusChange={onBrushRadiusChange}
          onClearPatternMask={onClearPatternMask}
          onGoToAuto={() => goToStep("auto")}
          onGoToExport={() => goToStep("export")}
          onRedoRetouch={onRedoRetouch}
          onRunDrawnPattern={onRunDrawnPattern}
          onSelectTool={onSelectTool}
          onUndoRetouch={onUndoRetouch}
          sizableTool={sizableTool}
          tool={tool}
        />
      ) : null}

      {step === "export" ? (
        <ExportInpaintingStep
          hasCurrentChapter={Boolean(currentChapter)}
          hasSelectedPage={Boolean(selectedPage)}
          inpaintedPageCount={inpaintedPageCount}
          jobActive={jobActive}
          onExportChapter={() => onExportResults("chapter")}
          onExportPage={() => onExportResults("page")}
          onGoToRetouch={() => goToStep("retouch")}
        />
      ) : null}
    </section>
  );
}
