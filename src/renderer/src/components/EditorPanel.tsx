import React from "react";
import type { RenderTextDirection, TranslationBlock } from "../../../shared/types";
import { resolveBlockVisualStyle } from "../../../shared/blockVisuals";
import { BLOCK_FONT_OPTIONS, normalizeBlockFontFamily, resolveBlockFontFamily, resolveBlockFontOption } from "../lib/fonts";

type EditorPanelProps = {
  block: TranslationBlock | null;
  disabled: boolean;
  areaTranslateAvailable?: boolean;
  areaTranslateSelecting?: boolean;
  onStartAreaTranslate?: () => void;
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

  const blockType = block.type;
  const outlineColor = resolveColor(block.outlineColor, "#ffffff");
  const selectedFont = resolveBlockFontOption(block.fontFamily);
  const autoFitText = block.autoFitText ?? true;
  const fontSizePx = clampFontSize(block.fontSizePx);
  const visualStyle = resolveBlockVisualStyle(blockType);

  return (
    <section className="editor-panel has-block">
      <h2>블록</h2>
      <label className="block-type-field">
        <span>종류</span>
        <span className="block-type-row">
          <select value={blockType} disabled={disabled} onChange={(event) => onUpdate({ type: event.target.value as TranslationBlock["type"] })}>
            <option value="solid">단색 배경</option>
            <option value="nonsolid">무늬 배경</option>
          </select>
          <span className="block-type-preview" aria-label="블록 표시 색상">
            <span className="block-type-swatch" style={{ borderColor: visualStyle.borderColor, backgroundColor: visualStyle.backgroundColor }} />
            <span>{blockType === "solid" ? "단색" : "무늬"}</span>
          </span>
        </span>
      </label>
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
        <input
          type="range"
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
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.01}
          value={block.opacity}
          disabled={disabled}
          onChange={(event) => onUpdate({ opacity: Number(event.target.value) })}
        />
      </label>
      <label className="font-field">
        <span className="font-field-label">폰트</span>
        <span className="font-select-wrap">
          <select
            value={selectedFont.id}
            disabled={disabled}
            onChange={(event) => onUpdate({ fontFamily: normalizeBlockFontFamily(event.target.value) })}
          >
            {BLOCK_FONT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="font-preview" style={{ fontFamily: resolveBlockFontFamily(selectedFont.id) }}>
            {selectedFont.sample}
          </span>
        </span>
      </label>
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
          <input
            type="range"
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
      <div className="color-stack" aria-label="블록 색상">
        <ColorField label="글자색" value={resolveColor(block.textColor, "#111111")} disabled={disabled} onChange={(textColor) => onUpdate({ textColor })} />
        <ColorField label="외곽선" value={outlineColor} disabled={disabled} onChange={(nextOutlineColor) => onUpdate({ outlineColor: nextOutlineColor })} />
      </div>
      <div className="block-actions">
        <button onClick={onDuplicate} disabled={disabled}>복제</button>
        <button className="danger" onClick={onDelete} disabled={disabled}>삭제</button>
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
