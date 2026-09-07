import {
  createWarpPreset,
  createWarpEvaluator,
} from "../src/shared/warpTransformMath";
import { describe, expect, it } from "vitest";
import {
  letteringMaskSvg,
  pagePointToLettering,
} from "../src/shared/generatedLetteringMask";
import type { LetteringMaskStroke } from "../src/shared/generatedLetteringMaskTypes";
import { letteringMaskStrokesSchema } from "../src/shared/generatedLetteringMaskSchemas";
import { createPageRevision } from "../src/shared/pageRevision";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
const block: TranslationBlock = {
  id: "b",
  bbox: { x: 250, y: 250, w: 500, h: 500 },
  type: "nonsolid",
  sourceText: "ドン",
  translatedText: "쿵",
  confidence: 1,
  sourceDirection: "horizontal",
  renderDirection: "horizontal",
  fontSizePx: 30,
  lineHeight: 1.2,
  textAlign: "center",
  textColor: "#000000",
  opacity: 0,
  backgroundColor: "#ffffff",
};
const stroke: LetteringMaskStroke = {
  space: "asset",
  mode: "hide",
  shape: "circle",
  points: [{ x: 500, y: 500 }],
  radiusX: 100,
  radiusY: 50,
  softness: 0,
};
describe("nondestructive lettering masks", () => {
  it("keeps hide and restore operations in drawing order", () => {
    const svg = letteringMaskSvg([
      stroke,
      { ...stroke, mode: "restore", shape: "square" },
    ]);
    expect(svg.indexOf('fill="black"')).toBeLessThan(
      svg.lastIndexOf('fill="white"'),
    );
    expect(svg).toContain("scale(100 50)");
    expect(svg).toContain('width="2" height="2"');
  });
  it("maps rotated native coordinates back onto the same asset pixels", () => {
    const page = { width: 800, height: 1200 };
    const at = pagePointToLettering(
      { x: 500, y: 583.33333333333 },
      { ...block, rotationDeg: 90 },
      page,
    );
    expect(at.x).toBeCloseTo(750);
    expect(at.y).toBeCloseTo(500);
    expect(pagePointToLettering({ x: 625, y: 500 }, block, page)).toEqual({
      x: 750,
      y: 500,
    });
  });
  it("maps a brush back through a warped asset across repeated points", () => {
    const warpTransform = createWarpPreset("archUp", 5);
    const forward = createWarpEvaluator(warpTransform);
    const warpedBlock = { ...block, warpTransform };
    for (const local of [
      { x: 0.2, y: 0.3 },
      { x: 0.6, y: 0.8 },
    ]) {
      const output = forward.map(local);
      const restored = pagePointToLettering(
        { x: 250 + output.x * 500, y: 250 + output.y * 500 },
        warpedBlock,
        { width: 800, height: 1200 },
      );
      expect(restored.x).toBeCloseTo(local.x * 1000, 0);
      expect(restored.y).toBeCloseTo(local.y * 1000, 0);
    }
  });
  it("rejects malformed or unbounded persisted strokes", () => {
    expect(letteringMaskStrokesSchema.element.safeParse(stroke).success).toBe(
      true,
    );
    expect(
      letteringMaskStrokesSchema.element.safeParse({ ...stroke, radiusX: 0 })
        .success,
    ).toBe(false);
    expect(
      letteringMaskStrokesSchema.element.safeParse({
        ...stroke,
        points: [{ x: Infinity, y: 0 }],
      }).success,
    ).toBe(false);
  });
  it("changes the page revision without changing original RGBA data", () => {
    const artwork = {
      version: 1 as const,
      sourceText: block.sourceText,
      translatedText: block.translatedText,
      dataUrl: "data:image/png;base64,unchanged",
    };
    const page: MangaPage = {
      id: "p",
      name: "p",
      imagePath: "p.png",
      dataUrl: "",
      width: 800,
      height: 1200,
      blocks: [{ ...block, generatedLettering: artwork }],
      analysisStatus: "completed",
      createdAt: "",
      updatedAt: "",
    };
    const edited = {
      ...page,
      blocks: [
        { ...block, generatedLettering: { ...artwork, maskStrokes: [stroke] } },
      ],
    };
    expect(createPageRevision(page)).not.toBe(createPageRevision(edited));
    expect(edited.blocks[0].generatedLettering.dataUrl).toBe(artwork.dataUrl);
  });
});
