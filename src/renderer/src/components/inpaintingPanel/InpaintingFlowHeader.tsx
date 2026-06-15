import React from "react";
import { STEP_LABELS, STEP_ORDER, type FlowStep } from "./inpaintingPanelTypes";

type InpaintingFlowHeaderProps = {
  onShowGuide: () => void;
  onStepChange: (step: FlowStep) => void;
  onToggleBlocks: () => void;
  onToggleChrome: () => void;
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  step: FlowStep;
};

export function InpaintingFlowHeader({
  onShowGuide,
  onStepChange,
  onToggleBlocks,
  onToggleChrome,
  showBlockChrome,
  showTextBlocks,
  step,
}: InpaintingFlowHeaderProps): React.JSX.Element {
  const stepIndex = STEP_ORDER.indexOf(step);

  return (
    <div className="inpaint-flow-head">
      <div
        className="inpaint-stepper"
        role="tablist"
        aria-label="인페인팅 단계"
      >
        {STEP_ORDER.map((value, index) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={step === value}
            className={`inpaint-step ${step === value ? "active" : ""} ${index < stepIndex ? "done" : ""}`}
            onClick={() => onStepChange(value)}
          >
            <span className="inpaint-step-num">{index + 1}</span>
            <span className="inpaint-step-label">{STEP_LABELS[value]}</span>
          </button>
        ))}
      </div>
      <div className="inpaint-flow-display">
        <button
          className={`chip-toggle ${showTextBlocks ? "active" : ""}`}
          onClick={onToggleBlocks}
          title="블록 표시 켜기/끄기"
        >
          블록
        </button>
        <button
          className={`chip-toggle ${showBlockChrome ? "active" : ""}`}
          onClick={onToggleChrome}
          title="배경/테두리 표시 켜기/끄기"
        >
          테두리
        </button>
        <button
          className="inpainting-guide-button"
          onClick={onShowGuide}
          title="인페인팅 사용법"
        >
          안내
        </button>
      </div>
    </div>
  );
}
