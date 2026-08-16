import React from "react";
import type { CurveLayout, TranslationBlock } from "../../../shared/textTypes";
import {
  resolveEffectiveTextColor,
  resolveEffectiveTextOutlineColor,
} from "../../../shared/textOutline";
import {
  parseRichText,
  type TextStyleRun,
} from "../../../shared/richTextMarkup";
import type { BlockFontCatalog } from "../lib/fonts";
import { resolveFontWidthScale } from "../lib/blockFormatGeometry";
import {
  layoutGlyphsOnCurve,
  type MeasuredCurveGlyph,
} from "../lib/curveGlyphLayout";
import type { BlockTextLayout } from "../lib/overlayLayout";
import {
  createTextRunStyleResolver,
  type TextRunStyleResolver,
} from "../lib/textStyleRunResolution";
import {
  resolveBlockTextOutlinePx,
} from "./overlayTextStyles";

let measureCanvas: HTMLCanvasElement | null = null;

export function CurveText({
  block,
  curveLayout,
  displayText,
  fontCatalog,
  layout,
}: {
  block: TranslationBlock;
  curveLayout: CurveLayout;
  displayText: string;
  fontCatalog: BlockFontCatalog;
  layout: BlockTextLayout;
}): React.JSX.Element {
  const resolveRunStyle = createTextRunStyleResolver(
    block,
    layout.fontSizePx,
    fontCatalog,
  );
  const glyphs = measureGlyphs(
    parseRichText(displayText, Boolean(block.bold), Boolean(block.italic)).runs,
    resolveRunStyle,
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
        opacity: 1,
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
          fill={resolveEffectiveTextColor(block)}
          fontFamily={glyph.fontFamily}
          fontSize={glyph.fontSizePx}
          fontStyle={glyph.italic ? "italic" : "normal"}
          fontWeight={glyph.bold ? 800 : 400}
          key={`${index}-${glyph.char}`}
          opacity={glyph.opacity}
          paintOrder="stroke fill"
          stroke={
            outlineWidth > 0 ? resolveEffectiveTextOutlineColor(block) : "none"
          }
          strokeLinecap="round"
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
  resolveRunStyle: TextRunStyleResolver,
): MeasuredCurveGlyph[] {
  const context = getMeasureContext();
  return runs.flatMap((run) => {
    const style = resolveRunStyle(run);
    context.font = resolveCanvasFont(
      run,
      style.fontSizePx,
      style.fontFamily,
    );
    return Array.from(run.text).map((char) => ({
      char,
      width: context.measureText(char).width,
      bold: run.bold,
      italic: run.italic,
      fontSizePx: style.fontSizePx,
      fontFamily: style.fontFamily,
      opacity: style.opacity,
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
