import React from "react";
import type { CurveLayout, TranslationBlock } from "../../../shared/textTypes";
import {
  resolveEffectiveTextColor,
  resolveEffectiveTextOutlineColor,
} from "../../../shared/textOutline";
import {
  resolveTextGlow,
  resolveTextGlowCssShadow,
} from "../../../shared/textGlow";
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
import { resolveBlockTextOutlinePx } from "./overlayTextStyles";

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
        <CurveGlyph
          block={block}
          glyph={glyph}
          key={`${index}-${glyph.char}`}
          layoutFontSizePx={layout.fontSizePx}
          outlineWidth={outlineWidth}
          widthScale={widthScale}
        />
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
    context.font = resolveCanvasFont(run, style.fontSizePx, style.fontFamily);
    return Array.from(run.text).map((char) => ({
      char,
      width: context.measureText(char).width,
      bold: run.bold,
      italic: run.italic,
      fontSizePx: style.fontSizePx,
      fontFamily: style.fontFamily,
      opacity: style.opacity,
      style: stripRunText(run),
    }));
  });
}

function CurveGlyph({
  block,
  glyph,
  layoutFontSizePx,
  outlineWidth,
  widthScale,
}: {
  block: TranslationBlock;
  glyph: ReturnType<typeof layoutGlyphsOnCurve>[number];
  layoutFontSizePx: number;
  outlineWidth: number;
  widthScale: number;
}): React.JSX.Element {
  const appearance = resolveCurveGlyphAppearance({
    block,
    glyph,
    layoutFontSizePx,
    outlineWidth,
    widthScale,
  });
  const transform = `translate(${glyph.x} ${glyph.y}) rotate(${glyph.angleDeg})`;
  return (
    <g transform={transform}>
      {appearance.backgroundColor ? (
        <CurveGlyphBackground
          color={appearance.backgroundColor}
          glyph={glyph}
          layoutFontSizePx={layoutFontSizePx}
        />
      ) : null}
      {appearance.outerWidth > 0 ? (
        <CurveGlyphText
          color="transparent"
          fill="none"
          glyph={glyph}
          stroke={appearance.outerColor}
          strokeWidth={(appearance.innerWidth + appearance.outerWidth) * 2}
          widthScale={appearance.widthScale}
        />
      ) : null}
      <CurveGlyphText
        color={appearance.mainColor}
        fill={appearance.mainColor}
        glyph={glyph}
        stroke={appearance.innerWidth > 0 ? appearance.innerColor : "none"}
        strokeWidth={appearance.innerWidth * 2}
        style={{
          filter: appearance.glowFilter,
          textDecorationLine: appearance.decoration || undefined,
          textDecorationColor: appearance.mainColor,
        }}
        widthScale={appearance.widthScale}
      />
      {appearance.emphasis ? (
        <CurveGlyphEmphasis
          color={appearance.mainColor}
          glyph={glyph}
          layoutFontSizePx={layoutFontSizePx}
        />
      ) : null}
    </g>
  );
}

type CurveGlyphAppearance = {
  backgroundColor?: string;
  decoration: string;
  emphasis: boolean;
  glowFilter?: string;
  innerColor: string;
  innerWidth: number;
  mainColor: string;
  outerColor: string;
  outerWidth: number;
  widthScale: number;
};

function resolveCurveGlyphAppearance({
  block,
  glyph,
  layoutFontSizePx,
  outlineWidth,
  widthScale,
}: {
  block: TranslationBlock;
  glyph: ReturnType<typeof layoutGlyphsOnCurve>[number];
  layoutFontSizePx: number;
  outlineWidth: number;
  widthScale: number;
}): CurveGlyphAppearance {
  const scale = layoutFontSizePx / Math.max(1, block.fontSizePx || 1);
  const style = glyph.style ?? { bold: glyph.bold, italic: glyph.italic };
  const innerWidth =
    style.outlineWidthPx === undefined
      ? outlineWidth
      : style.outlineWidthPx * scale;
  const outerWidth =
    style.outerOutlineWidthPx === undefined
      ? Math.max(0, block.outerOutlineWidthPx ?? 0)
      : style.outerOutlineWidthPx * scale;
  return {
    backgroundColor: style.backgroundColor,
    decoration: resolveCurveDecoration(block, style),
    emphasis: Boolean(block.emphasisMark || style.emphasisMark),
    glowFilter: resolveCurveGlowFilter(block, style, scale),
    innerColor: style.outlineColor ?? resolveEffectiveTextOutlineColor(block),
    innerWidth,
    mainColor: style.color ?? resolveEffectiveTextColor(block),
    outerColor: style.outerOutlineColor ?? block.outerOutlineColor ?? "#111111",
    outerWidth,
    widthScale: widthScale * (style.widthScale ?? 1),
  };
}

function resolveCurveDecoration(
  block: TranslationBlock,
  style: Omit<TextStyleRun, "text">,
): string {
  return [
    block.underline || style.underline ? "underline" : "",
    block.strikethrough || style.strikethrough ? "line-through" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function CurveGlyphBackground({
  color,
  glyph,
  layoutFontSizePx,
}: {
  color: string;
  glyph: ReturnType<typeof layoutGlyphsOnCurve>[number];
  layoutFontSizePx: number;
}): React.JSX.Element {
  const fontSizePx = glyph.fontSizePx ?? layoutFontSizePx;
  return (
    <rect
      fill={color}
      height={fontSizePx * 1.15}
      opacity={glyph.opacity}
      width={Math.max(1, glyph.width)}
      x={-glyph.width / 2}
      y={-fontSizePx * 0.575}
    />
  );
}

function CurveGlyphEmphasis({
  color,
  glyph,
  layoutFontSizePx,
}: {
  color: string;
  glyph: ReturnType<typeof layoutGlyphsOnCurve>[number];
  layoutFontSizePx: number;
}): React.JSX.Element {
  const fontSizePx = glyph.fontSizePx ?? layoutFontSizePx;
  return (
    <circle
      aria-hidden="true"
      cx={0}
      cy={-fontSizePx * 0.78}
      fill={color}
      opacity={glyph.opacity}
      r={Math.max(1, fontSizePx * 0.07)}
    />
  );
}

function CurveGlyphText({
  color,
  fill,
  glyph,
  stroke,
  strokeWidth,
  style,
  widthScale,
}: {
  color: string;
  fill: string;
  glyph: ReturnType<typeof layoutGlyphsOnCurve>[number];
  stroke: string;
  strokeWidth: number;
  style?: React.CSSProperties;
  widthScale: number;
}): React.JSX.Element {
  return (
    <text
      dominantBaseline="central"
      fill={fill}
      fontFamily={glyph.fontFamily}
      fontSize={glyph.fontSizePx}
      fontStyle={glyph.italic ? "italic" : "normal"}
      fontWeight={glyph.bold ? 800 : 400}
      opacity={glyph.opacity}
      paintOrder="stroke fill"
      stroke={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      style={{ color, ...style }}
      textAnchor="middle"
      transform={`scale(${widthScale} 1)`}
      x={0}
      y={0}
    >
      {glyph.char}
    </text>
  );
}

function resolveCurveGlowFilter(
  block: TranslationBlock,
  style: Omit<TextStyleRun, "text">,
  scale: number,
): string | undefined {
  const hasInline =
    style.glowColor !== undefined ||
    style.glowBlurPx !== undefined ||
    style.glowOpacity !== undefined;
  const base = resolveTextGlow(block.textGlow);
  const shadow = resolveTextGlowCssShadow(
    hasInline
      ? {
          enabled: true,
          color: style.glowColor ?? base.color,
          blurPx: style.glowBlurPx ?? base.blurPx,
          opacity: style.glowOpacity ?? base.opacity,
        }
      : block.textGlow,
    scale,
  );
  return shadow ? `drop-shadow(${shadow})` : undefined;
}

function stripRunText(run: TextStyleRun): Omit<TextStyleRun, "text"> {
  const { text: _text, ...style } = run;
  return style;
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
