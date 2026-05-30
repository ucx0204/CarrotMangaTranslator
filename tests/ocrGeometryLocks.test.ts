import { describe, expect, it } from "vitest";
import { applyOcrCandidateGeometryLocks, isOcrResultNoTextDetected } from "../src/main/wholePagePipeline";

const page = {
  id: "page-1",
  imagePath: "page.jpg",
  width: 1000,
  height: 1000
} as any;

describe("OCR candidate geometry locks", () => {
  it("treats OCR no-text metadata as the page skip signal", () => {
    expect(isOcrResultNoTextDetected({ hints: [], diagnostics: [], noTextDetected: true, textEvidenceCount: 0 })).toBe(true);
    expect(isOcrResultNoTextDetected({ hints: [], diagnostics: [], noTextDetected: false, textEvidenceCount: 0 })).toBe(false);
    expect(isOcrResultNoTextDetected(null)).toBe(false);
  });

  it("locks a model item only to its matching candidate id", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 1,
          type: "solid",
          bbox: { x: 104, y: 106, w: 88, h: 86 },
          jp: "jp",
          ko: "ko"
        }
      ],
      page,
      [{ id: 1, label: "text", x1: 100, y1: 100, x2: 200, y2: 200 }]
    );

    expect(result[0]?.bbox).toEqual({ x: 100, y: 100, w: 100, h: 100 });
  });

  it("does not silently move an item to a nearby unused candidate with a different id", () => {
    const originalBbox = { x: 510, y: 510, w: 70, h: 70 };
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 9,
          type: "solid",
          bbox: originalBbox,
          jp: "jp",
          ko: "ko"
        }
      ],
      page,
      [
        { id: 1, label: "text", x1: 100, y1: 100, x2: 200, y2: 200 },
        { id: 2, label: "text", x1: 500, y1: 500, x2: 600, y2: 600 }
      ]
    );

    expect(result[0]?.bbox).toEqual(originalBbox);
  });
});
