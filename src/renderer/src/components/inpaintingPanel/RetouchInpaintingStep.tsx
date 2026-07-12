import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { InpaintingTool } from "../../inpainting/inpaintingTypes";
import { Button, IconButton, RangeInput } from "../ui";
import {
  BrushIcon,
  MaskIcon,
  PickerIcon,
  RedoIcon,
  RestoreIcon,
  UndoIcon,
} from "../ui/icons";

type RetouchInpaintingStepProps = {
  activeToolLabel: string;
  brushColor: string;
  brushRadius: number;
  canRedo: boolean;
  canUndo: boolean;
  hasSelectedPage: boolean;
  jobActive: boolean;
  maskStrokeCount: number;
  onBrushColorChange: (value: string) => void;
  onBrushRadiusChange: (value: number) => void;
  onClearPatternMask: () => void;
  onGoToAuto: () => void;
  onGoToExport: () => void;
  onRedoRetouch: () => void;
  onRunDrawnPattern: () => void;
  onSelectTool: (tool: InpaintingTool) => void;
  onUndoRetouch: () => void;
  sizableTool: boolean;
  tool: InpaintingTool;
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

      <RetouchStepNav {...props} />
    </div>
  );
}

function RetouchToolsBar(props: RetouchInpaintingStepProps): React.JSX.Element {
  return (
    <div className="retouch-tools-bar">
      <RetouchToolsHeader {...props} />
      <RetouchToolButtons {...props} />
      {props.sizableTool ? <RetouchToolSettings {...props} /> : null}
    </div>
  );
}

function RetouchToolsHeader({
  activeToolLabel,
  canRedo,
  canUndo,
  jobActive,
  onRedoRetouch,
  onUndoRetouch,
}: RetouchInpaintingStepProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="retouch-tools-bar-head">
      <span className="retouch-active-tool">{activeToolLabel}</span>
      <div className="retouch-undo-redo">
        <IconButton
          size="sm"
          label={t("inpainting.retouch.undoLabel")}
          title={t("inpainting.retouch.undoLabel")}
          disabled={!canUndo || jobActive}
          onClick={onUndoRetouch}
        >
          <UndoIcon size={16} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("inpainting.retouch.redoLabel")}
          title={t("inpainting.retouch.redoTitle")}
          disabled={!canRedo || jobActive}
          onClick={onRedoRetouch}
        >
          <RedoIcon size={16} />
        </IconButton>
      </div>
    </div>
  );
}

function RetouchToolButtons({
  brushColor,
  jobActive,
  onSelectTool,
  tool,
}: RetouchInpaintingStepProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="retouch-toolbar tools-grid">
      <button
        className={tool === "mask" ? "active" : ""}
        disabled={jobActive}
        onClick={() => onSelectTool(tool === "mask" ? "none" : "mask")}
      >
        <MaskIcon size={18} />
        <span>{t("inpainting.tools.mask")}</span>
      </button>
      <button
        className={tool === "brush" ? "active" : ""}
        disabled={jobActive}
        onClick={() => onSelectTool(tool === "brush" ? "none" : "brush")}
      >
        <BrushIcon size={18} />
        <span>{t("inpainting.tools.brush")}</span>
        <i
          className="brush-swatch"
          style={{ backgroundColor: brushColor }}
          aria-hidden="true"
        />
      </button>
      <button
        className={tool === "eraser" ? "active" : ""}
        disabled={jobActive}
        onClick={() => onSelectTool(tool === "eraser" ? "none" : "eraser")}
      >
        <RestoreIcon size={18} />
        <span>{t("inpainting.tools.eraser")}</span>
      </button>
      <button
        className={tool === "picker" ? "active" : ""}
        disabled={jobActive}
        onClick={() => onSelectTool(tool === "picker" ? "none" : "picker")}
      >
        <PickerIcon size={18} />
        <span>{t("inpainting.tools.picker")}</span>
      </button>
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

function RetouchStepNav({
  jobActive,
  onGoToAuto,
  onGoToExport,
}: RetouchInpaintingStepProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="inpaint-step-nav">
      <Button variant="ghost" onClick={onGoToAuto}>
        {t("inpainting.retouch.backAuto")}
      </Button>
      <Button variant="primary" onClick={onGoToExport} disabled={jobActive}>
        {t("inpainting.retouch.nextExport")}
      </Button>
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
