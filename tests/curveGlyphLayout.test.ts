import { describe, expect, it } from "vitest";
import type { CurveLayout } from "../src/shared/textTypes";
import {
  layoutGlyphsOnCurve,
  type MeasuredCurveGlyph,
} from "../src/renderer/src/lib/curveGlyphLayout";

const straight: CurveLayout = {
  version: 1,
  path: {
    type: "quadratic",
    start: { x: 0, y: 0.5 },
    control: { x: 0.5, y: 0.5 },
    end: { x: 1, y: 0.5 },
  },
  alignment: "center",
  offsetEm: 0,
  orientation: "tangent",
};

const glyphs: MeasuredCurveGlyph[] = [
  { char: "A", width: 20, bold: false, italic: false },
  { char: "B", width: 20, bold: true, italic: false },
];

describe("curve glyph layout", () => {
  it("centers measured glyph advances on a straight path", () => {
    const result = layoutGlyphsOnCurve({
      glyphs,
      layout: straight,
      width: 200,
      height: 100,
      fontSizePx: 20,
      fontWidthScale: 1,
      letterSpacingPx: 0,
    });

    expect(result[0]).toMatchObject({ x: 90, angleDeg: 0 });
    expect(result[1]).toMatchObject({ x: 110, angleDeg: 0 });
    expect(result[0].y).toBeCloseTo(50);
    expect(result[1].y).toBeCloseTo(50);
  });

  it("applies width scaling, fit spacing, reverse, and tangent rotation", () => {
    const result = layoutGlyphsOnCurve({
      glyphs,
      layout: { ...straight, reversed: true, fitSpacing: true },
      width: 200,
      height: 100,
      fontSizePx: 20,
      fontWidthScale: 1,
      letterSpacingPx: 0,
    });

    expect(result[0].x).toBeCloseTo(190);
    expect(result[1].x).toBeCloseTo(10);
    expect(Math.abs(result[0].angleDeg)).toBeCloseTo(180);
  });

  it("offsets along the path normal and extrapolates overflowing text", () => {
    const result = layoutGlyphsOnCurve({
      glyphs: [{ ...glyphs[0], width: 240 }],
      layout: { ...straight, alignment: "start", offsetEm: 0.5 },
      width: 200,
      height: 100,
      fontSizePx: 20,
      fontWidthScale: 1,
      letterSpacingPx: 0,
    });

    expect(result[0].x).toBeCloseTo(120);
    expect(result[0].y).toBeCloseTo(60);
  });
});
