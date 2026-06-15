import React from "react";
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

export function RetouchInpaintingStep({
  activeToolLabel,
  brushColor,
  brushRadius,
  canRedo,
  canUndo,
  hasSelectedPage,
  jobActive,
  maskStrokeCount,
  onBrushColorChange,
  onBrushRadiusChange,
  onClearPatternMask,
  onGoToAuto,
  onGoToExport,
  onRedoRetouch,
  onRunDrawnPattern,
  onSelectTool,
  onUndoRetouch,
  sizableTool,
  tool,
}: RetouchInpaintingStepProps): React.JSX.Element {
  return (
    <div className="inpaint-step-body">
      <p className="inpaint-step-lead">
        남은 자국을 직접 다듬습니다. 효과음은 그려서 지우고, 자잘한 부분은
        붓·복원으로 정리하세요.
      </p>

      <div className="retouch-tools-bar">
        <div className="retouch-tools-bar-head">
          <span className="retouch-active-tool">{activeToolLabel}</span>
          <div className="retouch-undo-redo">
            <IconButton
              size="sm"
              label="되돌리기 (Ctrl+Z)"
              title="되돌리기 (Ctrl+Z)"
              disabled={!canUndo || jobActive}
              onClick={onUndoRetouch}
            >
              <UndoIcon size={16} />
            </IconButton>
            <IconButton
              size="sm"
              label="다시 실행 (Ctrl+Y)"
              title="다시 실행 (Ctrl+Y / Ctrl+Shift+Z)"
              disabled={!canRedo || jobActive}
              onClick={onRedoRetouch}
            >
              <RedoIcon size={16} />
            </IconButton>
          </div>
        </div>
        {sizableTool ? (
          <div className="retouch-tool-settings">
            <label className="brush-size-control">
              <span className="brush-size-label">크기</span>
              <RangeInput
                min={4}
                max={90}
                value={brushRadius}
                disabled={jobActive}
                onChange={(event) =>
                  onBrushRadiusChange(Number(event.target.value))
                }
              />
              <strong>{brushRadius}px</strong>
            </label>
            {tool === "brush" ? (
              <label className="brush-color-control" title="붓 색상">
                <input
                  type="color"
                  value={brushColor}
                  disabled={jobActive}
                  onChange={(event) => onBrushColorChange(event.target.value)}
                />
              </label>
            ) : null}
          </div>
        ) : (
          <p className="retouch-tool-hint">
            아래에서 도구를 선택하면 붓 크기·색상을 조절할 수 있어요. 마스크
            붓·붓·복원은 모두 같은 크기를 사용합니다.
          </p>
        )}
      </div>

      <div className="inpaint-group">
        <div className="inpaint-group-head">
          <h3>그려서 지우기</h3>
          <small>
            {maskStrokeCount > 0
              ? `그린 영역 ${maskStrokeCount}개`
              : "효과음 보정"}
          </small>
        </div>
        <div className="retouch-toolbar compact-toolbar">
          <button
            className={tool === "mask" ? "active mask-tool" : "mask-tool"}
            disabled={jobActive}
            onClick={() => onSelectTool(tool === "mask" ? "none" : "mask")}
          >
            <MaskIcon size={18} />
            <span>마스크 붓</span>
          </button>
          <Button
            size="sm"
            disabled={jobActive || maskStrokeCount === 0}
            onClick={onClearPatternMask}
          >
            비우기
          </Button>
        </div>
        <Button
          variant="primary"
          fullWidth
          disabled={jobActive || !hasSelectedPage || maskStrokeCount === 0}
          onClick={onRunDrawnPattern}
        >
          그린 영역 지우기
        </Button>
      </div>

      <div className="inpaint-group">
        <div className="inpaint-group-head">
          <h3>수동 보정</h3>
          <small>붓 · 복원 · 색 뽑기</small>
        </div>
        <div className="retouch-toolbar">
          <button
            className={tool === "brush" ? "active" : ""}
            disabled={jobActive}
            onClick={() => onSelectTool(tool === "brush" ? "none" : "brush")}
          >
            <BrushIcon size={18} />
            <span>붓</span>
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
            <span>복원</span>
          </button>
          <button
            className={tool === "picker" ? "active" : ""}
            disabled={jobActive}
            onClick={() => onSelectTool(tool === "picker" ? "none" : "picker")}
          >
            <PickerIcon size={18} />
            <span>색 뽑기</span>
          </button>
        </div>
      </div>

      <div className="inpaint-step-nav">
        <Button variant="ghost" onClick={onGoToAuto}>
          ← 자동
        </Button>
        <Button variant="primary" onClick={onGoToExport} disabled={jobActive}>
          출력 →
        </Button>
      </div>
    </div>
  );
}
