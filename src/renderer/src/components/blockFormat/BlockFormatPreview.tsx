import React from "react";
import type { TranslationBlock } from "../../../../shared/textTypes";
import { useFonts } from "../../fonts/useFonts";
import { resolveBlockFontFamily } from "../../lib/fonts";

export type BlockFormatPreviewValues = {
  fontFamily: string | undefined;
  fontSizePx: number;
  autoFitText: boolean;
  textAlign: TranslationBlock["textAlign"];
  renderDirection: TranslationBlock["renderDirection"];
  wordBreak: NonNullable<TranslationBlock["wordBreak"]>;
  bold: boolean;
  italic: boolean;
  lineHeight: number;
  letterSpacing: number;
  fontWidthScale: number;
  textColor: string;
  textOpacity: number;
  outlineColor: string | undefined;
  outlineWidthScale: number;
  rotationDeg: number;
};

export function BlockFormatPreview({
  autoFitLabel,
  description,
  exampleLabel,
  exampleText,
  placeholder,
  title,
  values,
  onExampleTextChange,
}: {
  autoFitLabel: string;
  description: string;
  exampleLabel: string;
  exampleText: string;
  placeholder: string;
  title: string;
  values: BlockFormatPreviewValues;
  onExampleTextChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <section className="gather-direct-preview">
      <BlockFormatPreviewHeader
        description={description}
        exampleLabel={exampleLabel}
        exampleText={exampleText}
        title={title}
        onExampleTextChange={onExampleTextChange}
      />
      <BlockFormatPreviewStage
        autoFitLabel={autoFitLabel}
        previewText={exampleText || placeholder}
        values={values}
      />
    </section>
  );
}

export function BlockFormatPreviewStage({
  autoFitLabel,
  compact = false,
  previewText,
  values,
}: {
  autoFitLabel: string;
  compact?: boolean;
  previewText: string;
  values: BlockFormatPreviewValues;
}): React.JSX.Element {
  const { catalog } = useFonts();
  const textShadow = resolvePreviewOutline(
    values.fontSizePx,
    values.outlineColor ?? "#ffffff",
    values.outlineWidthScale,
  );
  const vertical = values.renderDirection === "vertical";
  return (
    <div
      className="gather-direct-preview-stage"
      data-compact={compact}
      data-direction={values.renderDirection}
    >
      <div
        className="gather-direct-preview-rotation"
        style={{
          opacity: values.textOpacity,
          transform: `rotate(${values.rotationDeg}deg)`,
        }}
      >
        <div
          className="gather-direct-preview-text"
          style={
            {
              "--gather-preview-font-size": `${values.fontSizePx}px`,
              color: values.textColor,
              fontFamily: resolveBlockFontFamily(values.fontFamily, catalog),
              fontSize: `${values.fontSizePx}px`,
              fontStyle: values.italic ? "italic" : "normal",
              fontSynthesis: "weight style",
              fontWeight: values.bold ? 700 : 400,
              letterSpacing: values.letterSpacing
                ? `${values.letterSpacing}em`
                : undefined,
              lineHeight: values.lineHeight,
              textAlign: values.textAlign,
              textShadow,
              transform: `scaleX(${values.fontWidthScale})`,
              ...resolvePreviewWrappingStyle(values.wordBreak),
              writingMode: vertical ? "vertical-rl" : "horizontal-tb",
            } as React.CSSProperties
          }
        >
          {previewText}
        </div>
      </div>
      {values.autoFitText ? (
        <span className="gather-direct-preview-badge">{autoFitLabel}</span>
      ) : null}
    </div>
  );
}

function resolvePreviewOutline(
  fontSizePx: number,
  color: string,
  scale: number,
): string {
  if (scale <= 0) return "none";
  const width = Math.max(0.6, fontSizePx * 0.032 * scale);
  return [
    [-width, 0],
    [width, 0],
    [0, -width],
    [0, width],
    [-width, -width],
    [width, -width],
    [-width, width],
    [width, width],
  ]
    .map(([x, y]) => `${x}px ${y}px 0 ${color}`)
    .join(", ");
}

function resolvePreviewWrappingStyle(
  wordBreak: BlockFormatPreviewValues["wordBreak"],
): React.CSSProperties {
  return {
    overflowWrap: wordBreak === "break-word" ? "anywhere" : "normal",
    wordBreak,
  };
}

function BlockFormatPreviewHeader({
  description,
  exampleLabel,
  exampleText,
  title,
  onExampleTextChange,
}: {
  description: string;
  exampleLabel: string;
  exampleText: string;
  title: string;
  onExampleTextChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="gather-direct-preview-head">
      <div>
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
      <label className="gather-direct-preview-input">
        <span>{exampleLabel}</span>
        <input
          value={exampleText}
          maxLength={120}
          onChange={(event) => onExampleTextChange(event.target.value)}
        />
      </label>
    </div>
  );
}
