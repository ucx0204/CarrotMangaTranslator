import React from "react";
import type { RenderTextDirection, TranslationBlock } from "../../../shared/types";
import { FontSelect } from "./FontSelect";
import { Button, IconButton, RangeInput } from "./ui";
import { AlignCenterIcon, AlignLeftIcon, AlignRightIcon, BoldIcon, ItalicIcon } from "./ui/icons";

type EditorPanelProps = {
  block: TranslationBlock | null;
  disabled: boolean;
  areaTranslateAvailable?: boolean;
  areaTranslateSelecting?: boolean;
  onStartAreaTranslate?: () => void;
  onApplyFont?: (scope: "page" | "chapter") => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
};

export function EditorPanel({
  block,
  disabled,
  areaTranslateAvailable = false,
  areaTranslateSelecting = false,
  onStartAreaTranslate,
  onApplyFont,
  onUpdate,
  onDelete,
  onDuplicate
}: EditorPanelProps): React.JSX.Element {
  if (!block) {
    return (
      <section className="editor-panel muted">
        <h2>블록</h2>
        <button
          className={`area-translate-button ${areaTranslateSelecting ? "active" : ""}`}
          disabled={disabled || !areaTranslateAvailable}
          onClick={onStartAreaTranslate}
        >
          {areaTranslateSelecting ? "선택 취소" : "영역 번역"}
        </button>
      </section>
    );
  }

  const outlineColor = resolveColor(block.outlineColor, "#ffffff");
  const autoFitText = block.autoFitText ?? true;
  const fontSizePx = clampFontSize(block.fontSizePx);

  return (
    <section className="editor-panel has-block">
      <h2>블록</h2>
      <label>
        한국어
        <textarea value={block.translatedText} disabled={disabled} onChange={(event) => onUpdate({ translatedText: event.target.value })} />
      </label>
      <label>
        OCR
        <textarea value={block.sourceText} disabled={disabled} onChange={(event) => onUpdate({ sourceText: event.target.value })} />
      </label>
      <label>
        방향
        <select
          value={block.renderDirection}
          disabled={disabled}
          onChange={(event) => onUpdate({ renderDirection: event.target.value as RenderTextDirection })}
        >
          <option value="horizontal">horizontal</option>
          <option value="vertical">vertical</option>
          <option value="rotated">rotated</option>
          <option value="hidden">hidden</option>
        </select>
      </label>
      <label>
        기울기 {block.rotationDeg ?? 0}°
        <RangeInput
          min={-30}
          max={30}
          step={1}
          value={block.rotationDeg ?? 0}
          disabled={disabled}
          onChange={(event) => onUpdate({ rotationDeg: Number(event.target.value) })}
        />
      </label>
      <label>
        투명도 {Math.round(block.opacity * 100)}%
        <RangeInput
          min={0.1}
          max={1}
          step={0.01}
          value={block.opacity}
          disabled={disabled}
          onChange={(event) => onUpdate({ opacity: Number(event.target.value) })}
        />
      </label>
      <div className="font-field">
        <span className="font-field-label">폰트</span>
        <FontSelect value={block.fontFamily} disabled={disabled} onChange={(fontFamily) => onUpdate({ fontFamily })} />
      </div>
      {onApplyFont ? (
        <div className="font-apply-row">
          <span className="font-apply-label">이 폰트 일괄 적용</span>
          <div className="font-apply-buttons">
            <Button size="sm" disabled={disabled} onClick={() => onApplyFont("page")} title="이 페이지의 모든 블록에 적용">
              페이지
            </Button>
            <Button size="sm" disabled={disabled} onClick={() => onApplyFont("chapter")} title="이 화의 모든 페이지·블록에 적용">
              전체
            </Button>
          </div>
        </div>
      ) : null}
      <div className="block-style-row">
        <div className="block-style-group">
          <IconButton label="굵게" title="굵게" aria-pressed={Boolean(block.bold)} disabled={disabled} onClick={() => onUpdate({ bold: !block.bold })}>
            <BoldIcon size={16} />
          </IconButton>
          <IconButton label="기울임꼴" title="기울임꼴" aria-pressed={Boolean(block.italic)} disabled={disabled} onClick={() => onUpdate({ italic: !block.italic })}>
            <ItalicIcon size={16} />
          </IconButton>
        </div>
        <div className="block-style-group">
          <IconButton label="왼쪽 정렬" title="왼쪽 정렬" aria-pressed={block.textAlign === "left"} disabled={disabled} onClick={() => onUpdate({ textAlign: "left" })}>
            <AlignLeftIcon size={16} />
          </IconButton>
          <IconButton label="가운데 정렬" title="가운데 정렬" aria-pressed={block.textAlign === "center"} disabled={disabled} onClick={() => onUpdate({ textAlign: "center" })}>
            <AlignCenterIcon size={16} />
          </IconButton>
          <IconButton label="오른쪽 정렬" title="오른쪽 정렬" aria-pressed={block.textAlign === "right"} disabled={disabled} onClick={() => onUpdate({ textAlign: "right" })}>
            <AlignRightIcon size={16} />
          </IconButton>
        </div>
      </div>
      <div className="font-size-field">
        <div className="font-size-header">
          <span>글자 크기</span>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={autoFitText}
              disabled={disabled}
              onChange={(event) => onUpdate({ autoFitText: event.target.checked })}
            />
            자동 맞춤
          </label>
        </div>
        <div className="font-size-row">
          <RangeInput
            min={10}
            max={160}
            step={1}
            value={fontSizePx}
            disabled={disabled || autoFitText}
            onChange={(event) => onUpdate({ fontSizePx: clampFontSize(Number(event.target.value)), autoFitText: false })}
          />
          <input
            className="font-size-number"
            type="number"
            min={10}
            max={160}
            step={1}
            value={fontSizePx}
            disabled={disabled || autoFitText}
            onChange={(event) => onUpdate({ fontSizePx: clampFontSize(Number(event.target.value)), autoFitText: false })}
          />
        </div>
      </div>
      <div className="color-row" aria-label="블록 색상">
        <ColorField label="글자색" value={resolveColor(block.textColor, "#111111")} disabled={disabled} onChange={(textColor) => onUpdate({ textColor })} />
        <ColorField label="외곽선" value={outlineColor} disabled={disabled} onChange={(nextOutlineColor) => onUpdate({ outlineColor: nextOutlineColor })} />
      </div>
      <label className="outline-width-field">
        외곽선 두께 {Math.round((block.outlineWidthScale ?? 1) * 100)}%
        <RangeInput
          min={0}
          max={2.5}
          step={0.1}
          value={block.outlineWidthScale ?? 1}
          disabled={disabled}
          onChange={(event) => onUpdate({ outlineWidthScale: Number(event.target.value) })}
        />
      </label>
      <div className="block-actions">
        <Button fullWidth onClick={onDuplicate} disabled={disabled}>
          복제
        </Button>
        <Button variant="danger" fullWidth onClick={onDelete} disabled={disabled}>
          삭제
        </Button>
      </div>
    </section>
  );
}

type ColorFieldProps = {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
};

function ColorField({ label, value, disabled, onChange }: ColorFieldProps): React.JSX.Element {
  return (
    <label className="color-field">
      <span className="color-field-label">{label}</span>
      <span className="color-picker-button">
        <span className="color-swatch" style={{ backgroundColor: value }} aria-hidden="true" />
        <code>{value.toUpperCase()}</code>
        <input type="color" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} aria-label={label} />
      </span>
    </label>
  );
}

function resolveColor(value: string | undefined, fallback: string): string {
  const text = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 24;
  }
  return Math.max(10, Math.min(160, Math.round(value)));
}
