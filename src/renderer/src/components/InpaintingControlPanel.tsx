import React from "react";
import type { InpaintingContextValue } from "../inpainting/inpaintingTypes";
import { useInpainting } from "../inpainting/useInpainting";
import { InpaintingFlowHeader } from "./inpaintingPanel/InpaintingFlowHeader";
import { InpaintingProgressCard } from "./inpaintingPanel/InpaintingProgressCard";
import { InpaintingStepContent } from "./inpaintingPanel/InpaintingStepContent";
import type { FlowStep } from "./inpaintingPanel/inpaintingPanelTypes";

export { DisplayControlPanel } from "./inpaintingPanel/DisplayControlPanel";

export function InpaintingControlPanel(): React.JSX.Element {
  const context = useInpainting();
  const { onSelectTool } = context;
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

  return (
    <InpaintingPanelBody
      context={context}
      onStepChange={goToStep}
      step={step}
    />
  );
}

type InpaintingPanelCounts = {
  pageTargetCount: number;
  pendingPages: number;
  pendingTargetCount: number;
  sizableTool: boolean;
  totalPages: number;
};

function InpaintingPanelBody({
  context,
  onStepChange,
  step,
}: {
  context: InpaintingContextValue;
  onStepChange: (step: FlowStep) => void;
  step: FlowStep;
}): React.JSX.Element {
  const {
    inpaintedPageCount,
    jobState,
    progressSnapshot,
    showBlockChrome,
    showTextBlocks,
    onShowGuide,
    onToggleChrome,
    onToggleBlocks,
    onCancelJob,
  } = context;
  const counts = resolveInpaintingPanelCounts(context);

  const activeInpaintingJob =
    jobState.kind === "inpainting" && jobState.status !== "idle";

  return (
    <section className="inpainting-panel inpaint-flow">
      <InpaintingFlowHeader
        onShowGuide={onShowGuide}
        onStepChange={onStepChange}
        onToggleBlocks={onToggleBlocks}
        onToggleChrome={onToggleChrome}
        showBlockChrome={showBlockChrome}
        showTextBlocks={showTextBlocks}
        step={step}
      />

      <InpaintingCountBadges
        inpaintedPageCount={inpaintedPageCount}
        pageTargetCount={counts.pageTargetCount}
        pendingTargetCount={counts.pendingTargetCount}
      />

      {activeInpaintingJob ? (
        <InpaintingProgressCard
          jobState={jobState}
          progressSnapshot={progressSnapshot}
          onCancel={onCancelJob}
        />
      ) : null}

      <InpaintingStepContent
        context={context}
        counts={counts}
        onStepChange={onStepChange}
        step={step}
      />
    </section>
  );
}

function InpaintingCountBadges({
  inpaintedPageCount,
  pageTargetCount,
  pendingTargetCount,
}: {
  inpaintedPageCount: number;
  pageTargetCount: number;
  pendingTargetCount: number;
}): React.JSX.Element {
  return (
    <div className="inpainting-counts">
      <span className="type-stat nonsolid">이 페이지 {pageTargetCount}</span>
      <span className="type-stat nonsolid">남은 {pendingTargetCount}</span>
      <span className="type-stat review">완료 {inpaintedPageCount}</span>
    </div>
  );
}

function resolveInpaintingPanelCounts({
  blockCounts,
  currentChapter,
  tool,
}: InpaintingContextValue): InpaintingPanelCounts {
  return {
    pageTargetCount: blockCounts.selectedPage,
    pendingPages: blockCounts.pendingPages,
    pendingTargetCount: blockCounts.pendingTotal,
    sizableTool: tool === "mask" || tool === "brush" || tool === "eraser",
    totalPages: currentChapter?.pages.length ?? 0,
  };
}
