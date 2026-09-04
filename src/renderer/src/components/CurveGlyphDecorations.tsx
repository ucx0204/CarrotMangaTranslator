import React from "react";
import type { PositionedCurveGlyph } from "../lib/curveGlyphLayout";
import type { TextRunDecorations } from "../lib/textRunVisualStyles";

const DECORATION_THICKNESS_EM = 0.08;
const UNDERLINE_OFFSET_EM = 0.42;
const STRIKETHROUGH_OFFSET_EM = 0;

export function CurveGlyphDecorations({
  color,
  decorations,
  glyph,
  layoutFontSizePx,
}: {
  color: string;
  decorations: TextRunDecorations;
  glyph: PositionedCurveGlyph;
  layoutFontSizePx: number;
}): React.JSX.Element | null {
  if (!decorations.underline && !decorations.strikethrough) return null;
  const fontSizePx = glyph.fontSizePx ?? layoutFontSizePx;
  const strokeWidth = fontSizePx * DECORATION_THICKNESS_EM;
  return (
    <>
      {decorations.underline ? (
        <CurveGlyphDecorationLine
          color={color}
          glyph={glyph}
          kind="underline"
          strokeWidth={strokeWidth}
          y={fontSizePx * UNDERLINE_OFFSET_EM}
        />
      ) : null}
      {decorations.strikethrough ? (
        <CurveGlyphDecorationLine
          color={color}
          glyph={glyph}
          kind="strikethrough"
          strokeWidth={strokeWidth}
          y={fontSizePx * STRIKETHROUGH_OFFSET_EM}
        />
      ) : null}
    </>
  );
}

function CurveGlyphDecorationLine({
  color,
  glyph,
  kind,
  strokeWidth,
  y,
}: {
  color: string;
  glyph: PositionedCurveGlyph;
  kind: keyof TextRunDecorations;
  strokeWidth: number;
  y: number;
}): React.JSX.Element {
  return (
    <line
      aria-hidden="true"
      data-curve-decoration={kind}
      opacity={glyph.opacity}
      stroke={color}
      strokeLinecap="butt"
      strokeWidth={strokeWidth}
      x1={-glyph.width / 2}
      x2={glyph.width / 2}
      y1={y}
      y2={y}
    />
  );
}
