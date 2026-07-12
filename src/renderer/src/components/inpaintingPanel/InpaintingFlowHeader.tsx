import React from "react";
import { useTranslation } from "react-i18next";
import { STEP_ORDER, type FlowStep } from "./inpaintingPanelTypes";

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
  const { t } = useTranslation("components");
  const stepIndex = STEP_ORDER.indexOf(step);

  return (
    <div className="inpaint-flow-head">
      <div
        className="inpaint-stepper"
        role="tablist"
        aria-label={t("inpainting.steps.label")}
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
            <span className="inpaint-step-label">
              {t(`inpainting.steps.${value}`)}
            </span>
          </button>
        ))}
      </div>
      <div className="inpaint-flow-display">
        <button
          className={`chip-toggle ${showTextBlocks ? "active" : ""}`}
          onClick={onToggleBlocks}
          title={t("inpainting.steps.toggleBlocks")}
        >
          {t("common.blocks")}
        </button>
        <button
          className={`chip-toggle ${showBlockChrome ? "active" : ""}`}
          onClick={onToggleChrome}
          title={t("inpainting.steps.toggleBorders")}
        >
          {t("inpainting.steps.borders")}
        </button>
        <button
          className="inpainting-guide-button"
          onClick={onShowGuide}
          title={t("inpainting.steps.guideTitle")}
        >
          {t("inpainting.steps.guide")}
        </button>
      </div>
    </div>
  );
}
