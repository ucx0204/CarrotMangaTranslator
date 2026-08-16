import React from "react";
import type { TranslationBlock } from "../../../../shared/textTypes";
import {
  resolveEffectiveTextOutlineColor,
  resolveEffectiveTextOutlineWidthPx,
} from "../../../../shared/textOutline";
import { useFonts } from "../../fonts/useFonts";
import { resolveBlockFontFamily } from "../../lib/fonts";
import { TextWithVerticalSpacing } from "../VerticalTextSpacing";

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
  outlineWidthPx: number;
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
  const outlineWidthPx = resolveEffectiveTextOutlineWidthPx(
    values,
    values.fontSizePx,
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
              textShadow: "none",
              WebkitTextStrokeColor:
                outlineWidthPx > 0
                  ? resolveEffectiveTextOutlineColor(values)
                  : "transparent",
              WebkitTextStrokeWidth: `${outlineWidthPx * 2}px`,
              paintOrder: "stroke fill",
              transform: `scaleX(${values.fontWidthScale})`,
              ...resolvePreviewWrappingStyle(values.wordBreak),
              writingMode: vertical ? "vertical-rl" : "horizontal-tb",
            } as React.CSSProperties
          }
        >
          <TextWithVerticalSpacing
            direction={values.renderDirection}
            text={previewText}
          />
        </div>
      </div>
      {values.autoFitText ? (
        <span className="gather-direct-preview-badge">{autoFitLabel}</span>
      ) : null}
    </div>
  );
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
        {description ? <small>{description}</small> : null}
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
