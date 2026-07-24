import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { RetouchTool } from "../../lib/stageTool";
import { Button } from "../ui/Button";
import { RangeInput } from "../ui/Field";

type RetouchInpaintingStepProps = {
  activeToolLabel: string;
  brushColor: string;
  brushRadius: number;
  hasSelectedPage: boolean;
  jobActive: boolean;
  maskStrokeCount: number;
  onBrushColorChange: (value: string) => void;
  onBrushRadiusChange: (value: number) => void;
  onClearPatternMask: () => void;
  onRunDrawnPattern: () => void;
  sizableTool: boolean;
  tool: RetouchTool;
};

export function RetouchInpaintingStep(
  props: RetouchInpaintingStepProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const maskActive = props.tool === "mask" || props.maskStrokeCount > 0;

  return (
    <div className="inpaint-step-body">
      <p className="inpaint-step-lead">{t("inpainting.retouch.description")}</p>

      <RetouchToolsBar {...props} />

      {maskActive ? <DrawnMaskActionGroup {...props} /> : null}
    </div>
  );
}

function RetouchToolsBar(props: RetouchInpaintingStepProps): React.JSX.Element {
  return (
    <div className="retouch-tools-bar">
      <RetouchToolsHeader {...props} />
      {props.sizableTool ? <RetouchToolSettings {...props} /> : null}
    </div>
  );
}

function RetouchToolsHeader({
  activeToolLabel,
}: RetouchInpaintingStepProps): React.JSX.Element {
  return (
    <div className="retouch-tools-bar-head">
      <span className="retouch-active-tool">{activeToolLabel}</span>
    </div>
  );
}

function RetouchToolSettings({
  brushColor,
  brushRadius,
  jobActive,
  onBrushColorChange,
  onBrushRadiusChange,
  tool,
}: RetouchInpaintingStepProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="retouch-tool-settings">
      <label className="brush-size-control">
        <span className="brush-size-label">{t("format.size")}</span>
        <RangeInput
          min={4}
          max={90}
          value={brushRadius}
          disabled={jobActive}
          onChange={(event) => onBrushRadiusChange(Number(event.target.value))}
        />
        <strong>{brushRadius}px</strong>
      </label>
      {tool === "brush" ? (
        <label
          className="brush-color-control"
          title={t("inpainting.retouch.brushColor")}
        >
          <input
            type="color"
            aria-label={t("inpainting.retouch.brushColor")}
            value={brushColor}
            disabled={jobActive}
            onChange={(event) => onBrushColorChange(event.target.value)}
          />
        </label>
      ) : null}
    </div>
  );
}

function DrawnMaskActionGroup({
  hasSelectedPage,
  jobActive,
  maskStrokeCount,
  onClearPatternMask,
  onRunDrawnPattern,
}: RetouchInpaintingStepProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="inpaint-group">
      <div className="inpaint-group-head">
        <h3>{t("inpainting.retouch.eraseDrawn")}</h3>
        <small>{resolveMaskStrokeLabel(maskStrokeCount, t)}</small>
      </div>
      <div className="mask-action-row">
        <Button
          size="sm"
          disabled={jobActive || maskStrokeCount === 0}
          onClick={onClearPatternMask}
        >
          {t("common.clear")}
        </Button>
        <Button
          variant="primary"
          fullWidth
          disabled={jobActive || !hasSelectedPage || maskStrokeCount === 0}
          onClick={onRunDrawnPattern}
        >
          {t("inpainting.retouch.eraseDrawnArea")}
        </Button>
      </div>
    </div>
  );
}

function resolveMaskStrokeLabel(
  maskStrokeCount: number,
  t: TFunction<"components">,
): string {
  return maskStrokeCount > 0
    ? t("inpainting.retouch.drawnAreas", { count: maskStrokeCount })
    : t("inpainting.retouch.soundEffectTouchup");
}
