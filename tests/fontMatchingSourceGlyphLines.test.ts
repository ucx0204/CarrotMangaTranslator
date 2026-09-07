import { describe, expect, it } from "vitest";
import { buildFontMatchingSourceGlyphInput } from "../src/main/pipeline/fontMatchingCrossScriptProxyHints";
import { makePage } from "./helpers/automaticFontMatchingV2Fixtures";

const parent = {
  id: 7,
  x1: 100,
  y1: 100,
  x2: 180,
  y2: 260,
  ocrText: "秘密の台詞",
};
const lines = [
  { x1: 150, y1: 110, x2: 178, y2: 170, ocrText: "秘密" },
  { x1: 105, y1: 130, x2: 135, y2: 220, ocrText: "の台詞" },
];
function build(recognitionSegments?: unknown) {
  return buildFontMatchingSourceGlyphInput({
    page: { ...makePage(), width: 1000, height: 1400 },
    item: {
      id: 1,
      type: "nonsolid",
      direction: "vertical",
      candidateIds: [7],
      bbox: { x: 100, y: 100, w: 80, h: 160 },
      jp: "秘密の台詞",
      ko: "번역",
    },
    rawHints: [
      { ...parent, recognitionSegments },
      { ...parent, id: 8, recognitionSegments: lines },
    ],
  });
}

describe("OCR recognition segment ownership at the font input boundary", () => {
  it("preserves the two supplied recognition regions and their separate glyph counts", () => {
    const result = build(lines);
    expect(result?.lines).toHaveLength(2);
    for (const [i, line] of lines.entries()) {
      const actual = result?.lines[i];
      expect(actual?.x1).toBeCloseTo(line.x1);
      expect(actual?.x2).toBeCloseTo(line.x2);
      expect(actual?.y1).toBeCloseTo(line.y1);
      expect(actual?.y2).toBeCloseTo(line.y2);
    }
    expect(result?.lines.map((line) => line.glyphCount)).toEqual([2, 3]);
    expect(JSON.stringify(result)).not.toContain("秘密");
    expect(JSON.stringify(result)).not.toContain("번역");
  });
  it.each([
    undefined,
    [],
    [lines[0]],
    [lines[0], null],
    [lines[0], lines[0]],
    [lines[0], { ...lines[1], x2: 900 }],
    [lines[0], { ...lines[1], y1: Number.NaN }],
    [lines[0], { ...lines[1], ocrText: "" }],
  ])(
    "preserves the bound region when the line inventory is incomplete or invalid: %j",
    (segments) => {
      expect(build(segments)?.lines).toEqual([
        { x1: 100, y1: 100, x2: 180, y2: 260, glyphCount: 5 },
      ]);
    },
  );
});
