import React from "react";
import type { CurveLayout, TranslationBlock } from "../../../shared/textTypes";
import {
  parseRichText,
  type TextStyleRun,
} from "../../../shared/richTextMarkup";
import { resolveBlockFontFamily } from "../lib/fonts";
import { resolveFontWidthScale } from "../lib/blockFormatGeometry";
import {
  layoutGlyphsOnCurve,
  type MeasuredCurveGlyph,
} from "../lib/curveGlyphLayout";
import type { BlockTextLayout } from "../lib/overlayLayout";
import {
  normalizeTextOpacity,
  resolveBlockTextOutlinePx,
  resolveCssColor,
} from "./overlayTextStyles";

let measureCanvas: HTMLCanvasElement | null = null;

export function CurveText({
  block,
  curveLayout,
  displayText,
  layout,
}: {
  block: TranslationBlock;
  curveLayout: CurveLayout;
  displayText: string;
  layout: BlockTextLayout;
}): React.JSX.Element {
  const fontFamily = resolveBlockFontFamily(block.fontFamily);
  const glyphs = measureGlyphs(
    parseRichText(displayText, Boolean(block.bold), Boolean(block.italic)).runs,
    layout.fontSizePx,
    fontFamily,
  );
  const widthScale = resolveFontWidthScale(block.fontWidthScale);
  const positioned = layoutGlyphsOnCurve({
    glyphs,
    layout: curveLayout,
    width: layout.layoutWidth,
    height: layout.layoutHeight,
    fontSizePx: layout.fontSizePx,
    fontWidthScale: widthScale,
    letterSpacingPx: (block.letterSpacing ?? 0) * layout.fontSizePx,
  });
  const outlineWidth = resolveBlockTextOutlinePx(block, layout.fontSizePx);

  return (
    <svg
      aria-label={parseRichText(displayText).plainText}
      className="overlay-curve-text"
      height={layout.layoutHeight}
      role="img"
      style={{
        opacity: normalizeTextOpacity(block.textOpacity),
        transform:
          layout.textScaleX === 1 && layout.textScaleY === 1
            ? undefined
            : `scale(${layout.textScaleX}, ${layout.textScaleY})`,
        transformOrigin: "top left",
      }}
      viewBox={`0 0 ${layout.layoutWidth} ${layout.layoutHeight}`}
      width={layout.layoutWidth}
    >
      {positioned.map((glyph, index) => (
        <text
          dominantBaseline="central"
          fill={resolveCssColor(block.textColor, "#111111")}
          fontFamily={fontFamily}
          fontSize={layout.fontSizePx}
          fontStyle={glyph.italic ? "italic" : "normal"}
          fontWeight={glyph.bold ? 800 : 400}
          key={`${index}-${glyph.char}`}
          paintOrder="stroke fill"
          stroke={resolveCssColor(block.outlineColor, "#ffffff")}
          strokeLinejoin="round"
          strokeWidth={outlineWidth * 2}
          textAnchor="middle"
          transform={`translate(${glyph.x} ${glyph.y}) rotate(${glyph.angleDeg}) scale(${widthScale} 1)`}
          x={0}
          y={0}
        >
          {glyph.char}
        </text>
      ))}
    </svg>
  );
}

function measureGlyphs(
  runs: TextStyleRun[],
  fontSizePx: number,
  fontFamily: string,
): MeasuredCurveGlyph[] {
  const context = getMeasureContext();
  return runs.flatMap((run) => {
    context.font = resolveCanvasFont(run, fontSizePx, fontFamily);
    return Array.from(run.text).map((char) => ({
      char,
      width: context.measureText(char).width,
      bold: run.bold,
      italic: run.italic,
    }));
  });
}

function resolveCanvasFont(
  run: Pick<TextStyleRun, "bold" | "italic">,
  fontSizePx: number,
  fontFamily: string,
): string {
  return `${run.italic ? "italic" : "normal"} ${run.bold ? 800 : 400} ${fontSizePx}px ${fontFamily}`;
}

function getMeasureContext(): CanvasRenderingContext2D {
  measureCanvas ??= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (!context) throw new Error("Canvas context is not available");
  return context;
}
