import React from "react";
import type { RenderTextDirection, TranslationBlock } from "../../../shared/types";

type EditorPanelProps = {
  block: TranslationBlock | null;
  disabled: boolean;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
};

export function EditorPanel({ block, disabled, onUpdate, onDelete, onDuplicate }: EditorPanelProps): React.JSX.Element {
  if (!block) {
    return (
      <section className="editor-panel muted">
        <h2>블록</h2>
        <p>블록을 선택하면 문구와 배치 방향을 바로 조정할 수 있습니다.</p>
      </section>
    );
  }

  const blockType = block.type === "other" ? "caption" : block.type;
  const outlineColor = resolveColor(block.outlineColor, "#ffffff");

  return (
    <section className="editor-panel has-block">
      <h2>블록</h2>
      <label>
        종류
        <select value={blockType} disabled={disabled} onChange={(event) => onUpdate({ type: event.target.value as TranslationBlock["type"] })}>
          <option value="speech">speech</option>
          <option value="sfx">sfx</option>
          <option value="caption">caption</option>
        </select>
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
      <div className="color-stack" aria-label="블록 색상">
        <ColorField label="글자색" value={resolveColor(block.textColor, "#111111")} disabled={disabled} onChange={(textColor) => onUpdate({ textColor })} />
        <ColorField label="외곽선" value={outlineColor} disabled={disabled} onChange={(nextOutlineColor) => onUpdate({ outlineColor: nextOutlineColor })} />
        <ColorField
          label="배경색"
          value={resolveColor(block.backgroundColor, "#fffdf5")}
          disabled={disabled}
          onChange={(backgroundColor) => onUpdate({ backgroundColor })}
        />
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
