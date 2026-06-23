import React from "react";
import type {
  BlockFormatDefaults,
  BlockFormatDirectionDefault,
} from "../../../../shared/settingsTypes";
import { ColorField } from "../ColorField";
import { FontSelect } from "../FontSelect";
import { FieldSlider, IconButton, RangeInput } from "../ui";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  ItalicIcon,
} from "../ui/icons";

export type FormatDefaultsPanelProps = {
  value: BlockFormatDefaults;
  onChange: (patch: Partial<BlockFormatDefaults>) => void;
};

type SectionProps = FormatDefaultsPanelProps;

const DIRECTION_OPTIONS: { id: BlockFormatDirectionDefault; label: string }[] =
  [
    { id: "auto", label: "자동" },
    { id: "horizontal", label: "가로" },
    { id: "vertical", label: "세로" },
  ];

export function FormatDefaultsPanel({
  value,
  onChange,
}: FormatDefaultsPanelProps): React.JSX.Element {
  return (
    <div className="format-defaults">
      <p className="muted-line modal-note">
        새로 만들어지는 텍스트 블록에 적용할 기본 서식입니다. 기존 블록은 바뀌지
        않습니다.
      </p>
      <DirectionAlignSection value={value} onChange={onChange} />
      <FontSizeSection value={value} onChange={onChange} />
      <SpacingSection value={value} onChange={onChange} />
      <ColorSection value={value} onChange={onChange} />
    </div>
  );
}

function DirectionAlignSection({
  value,
  onChange,
}: SectionProps): React.JSX.Element {
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>정렬 · 방향</h3>
      </div>
      <div className="format-toolbar">
        <div className="block-style-group">
          <IconButton
            label="굵게"
            title="굵게"
            aria-pressed={value.bold}
            onClick={() => onChange({ bold: !value.bold })}
          >
            <BoldIcon size={18} />
          </IconButton>
          <IconButton
            label="기울임꼴"
            title="기울임꼴"
            aria-pressed={value.italic}
            onClick={() => onChange({ italic: !value.italic })}
          >
            <ItalicIcon size={18} />
          </IconButton>
        </div>
        <div className="block-style-group">
          {(["left", "center", "right"] as const).map((align) => (
            <IconButton
              key={align}
              label={ALIGN_LABELS[align]}
              title={ALIGN_LABELS[align]}
              aria-pressed={value.textAlign === align}
              onClick={() => onChange({ textAlign: align })}
            >
              <AlignIcon align={align} />
            </IconButton>
          ))}
        </div>
        <div className="dir-toggle" role="group" aria-label="쓰기 방향">
          {DIRECTION_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={value.renderDirection === option.id}
              onClick={() => onChange({ renderDirection: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function FontSizeSection({ value, onChange }: SectionProps): React.JSX.Element {
  const setSize = (raw: number): void =>
    onChange({ fontSizePx: clampFontSize(raw) });
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>글꼴 · 크기</h3>
      </div>
      <div className="font-field">
        <FontSelect
          value={value.fontFamily}
          onChange={(fontFamily) => onChange({ fontFamily })}
        />
      </div>
      <div className="font-size-row">
        <span className="font-size-label">크기</span>
        <RangeInput
          aria-label="기본 글자 크기"
          min={10}
          max={160}
          step={1}
          value={value.fontSizePx}
          disabled={value.autoFitText}
          onChange={(event) => setSize(Number(event.target.value))}
        />
        <input
          className="font-size-number"
          type="number"
          aria-label="기본 글자 크기 값"
          min={10}
          max={160}
          step={1}
          value={value.fontSizePx}
          disabled={value.autoFitText}
          onChange={(event) => setSize(Number(event.target.value))}
        />
        <label className="inline-toggle" title="텍스트 상자에 맞춰 자동 크기">
          <input
            type="checkbox"
            checked={value.autoFitText}
            onChange={(event) =>
              onChange({ autoFitText: event.target.checked })
            }
          />
          자동
        </label>
      </div>
    </div>
  );
}

function SpacingSection({ value, onChange }: SectionProps): React.JSX.Element {
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>간격</h3>
      </div>
      <FieldSlider
        label="줄 간격"
        valueLabel={value.lineHeight.toFixed(2)}
        min={0.8}
        max={3}
        step={0.05}
        value={value.lineHeight}
        onChange={(event) =>
          onChange({ lineHeight: round2(Number(event.target.value)) })
        }
      />
      <FieldSlider
        label="자간"
        valueLabel={value.letterSpacing.toFixed(2)}
        min={-0.1}
        max={0.5}
        step={0.01}
        value={value.letterSpacing}
        onChange={(event) =>
          onChange({ letterSpacing: round2(Number(event.target.value)) })
        }
      />
    </div>
  );
}

function ColorSection({ value, onChange }: SectionProps): React.JSX.Element {
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>색상 · 외곽선</h3>
      </div>
      <div className="color-row" aria-label="기본 색상">
        <ColorField
          label="글자색"
          value={value.textColor}
          disabled={false}
          onChange={(textColor) => onChange({ textColor })}
        />
        <ColorField
          label="외곽선"
          value={value.outlineColor}
          disabled={!value.outlineEnabled}
          onChange={(outlineColor) => onChange({ outlineColor })}
        />
      </div>
      <label className="inline-toggle" title="외곽선 사용 여부">
        <input
          type="checkbox"
          checked={value.outlineEnabled}
          onChange={(event) =>
            onChange({ outlineEnabled: event.target.checked })
          }
        />
        외곽선 사용
      </label>
      <FieldSlider
        label="외곽선"
        valueLabel={`${Math.round(value.outlineWidthScale * 100)}%`}
        min={0}
        max={2.5}
        step={0.1}
        value={value.outlineWidthScale}
        disabled={!value.outlineEnabled}
        onChange={(event) =>
          onChange({ outlineWidthScale: Number(event.target.value) })
        }
      />
    </div>
  );
}

const ALIGN_LABELS: Record<"left" | "center" | "right", string> = {
  left: "왼쪽 정렬",
  center: "가운데 정렬",
  right: "오른쪽 정렬",
};

function AlignIcon({
  align,
}: {
  align: "left" | "center" | "right";
}): React.JSX.Element {
  if (align === "left") {
    return <AlignLeftIcon size={18} />;
  }
  if (align === "right") {
    return <AlignRightIcon size={18} />;
  }
  return <AlignCenterIcon size={18} />;
}

function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 24;
  }
  return Math.max(10, Math.min(160, Math.round(value)));
}

function round2(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}
