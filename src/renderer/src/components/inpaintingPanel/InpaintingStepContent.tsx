import React from "react";
import type {
  InpaintingContextValue,
  InpaintingTool,
} from "../../inpainting/inpaintingTypes";
import { AutoInpaintingStep } from "./AutoInpaintingStep";
import { ExportInpaintingStep } from "./ExportInpaintingStep";
import type { FlowStep } from "./inpaintingPanelTypes";
import { RetouchInpaintingStep } from "./RetouchInpaintingStep";

const INPAINTING_TOOL_LABELS: Record<InpaintingTool, string> = {
  brush: "붓",
  eraser: "복원",
  mask: "마스크 붓",
  none: "도구를 선택하세요",
  picker: "색 뽑기",
};

type InpaintingStepContentProps = {
  context: InpaintingContextValue;
  counts: InpaintingStepCounts;
  onStepChange: (step: FlowStep) => void;
  step: FlowStep;
};

type InpaintingStepCounts = {
  pageTargetCount: number;
  pendingPages: number;
  pendingTargetCount: number;
  sizableTool: boolean;
  totalPages: number;
};

export function InpaintingStepContent(
  props: InpaintingStepContentProps,
): React.JSX.Element {
  if (props.step === "auto") {
    return <AutoStepPanel {...props} />;
  }
  if (props.step === "retouch") {
    return <RetouchStepPanel {...props} />;
  }
  return <ExportStepPanel {...props} />;
}

function AutoStepPanel({
  context,
  counts,
  onStepChange,
}: InpaintingStepContentProps): React.JSX.Element {
  const { currentChapter, selectedPage } = context;

  return (
    <AutoInpaintingStep
      hasCurrentChapter={Boolean(currentChapter)}
      hasSelectedPage={Boolean(selectedPage)}
      inpaintedPageCount={context.inpaintedPageCount}
      jobActive={context.jobActive}
      onGoToRetouch={() => onStepChange("retouch")}
      onPeekToggle={context.onPeekToggle}
      onRevertChapter={context.onRevertChapter}
      onRevertPage={context.onRevertPage}
      onRunChapter={context.onRunChapter}
      onRunPage={context.onRunPage}
      pageTargetCount={counts.pageTargetCount}
      peekAvailable={context.peekAvailable}
      peeking={context.peeking}
      pendingPages={counts.pendingPages}
      pendingTargetCount={counts.pendingTargetCount}
      selectedPageInpainted={Boolean(selectedPage?.inpaintedImagePath)}
      totalPages={counts.totalPages}
    />
  );
}

function RetouchStepPanel({
  context,
  counts,
  onStepChange,
}: InpaintingStepContentProps): React.JSX.Element {
  const { selectedPage, tool } = context;

  return (
    <RetouchInpaintingStep
      activeToolLabel={INPAINTING_TOOL_LABELS[tool]}
      brushColor={context.brushColor}
      brushRadius={context.brushRadius}
      canRedo={context.canRedo}
      canUndo={context.canUndo}
      hasSelectedPage={Boolean(selectedPage)}
      jobActive={context.jobActive}
      maskStrokeCount={context.maskStrokeCount}
      onBrushColorChange={context.onBrushColorChange}
      onBrushRadiusChange={context.onBrushRadiusChange}
      onClearPatternMask={context.onClearPatternMask}
      onGoToAuto={() => onStepChange("auto")}
      onGoToExport={() => onStepChange("export")}
      onRedoRetouch={context.onRedoRetouch}
      onRunDrawnPattern={context.onRunDrawnPattern}
      onSelectTool={context.onSelectTool}
      onUndoRetouch={context.onUndoRetouch}
      sizableTool={counts.sizableTool}
      tool={tool}
    />
  );
}

function ExportStepPanel({
  context,
  onStepChange,
}: InpaintingStepContentProps): React.JSX.Element {
  return (
    <ExportInpaintingStep
      hasCurrentChapter={Boolean(context.currentChapter)}
      hasSelectedPage={Boolean(context.selectedPage)}
      inpaintedPageCount={context.inpaintedPageCount}
      jobActive={context.jobActive}
      onExportChapter={() => context.onExportResults("chapter")}
      onExportPage={() => context.onExportResults("page")}
      onGoToRetouch={() => onStepChange("retouch")}
    />
  );
}
