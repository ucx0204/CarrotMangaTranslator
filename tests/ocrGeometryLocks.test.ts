import { describe, expect, it } from "vitest";
import { isOcrResultNoTextDetected } from "../src/main/pipeline/noText";
import { applyOcrCandidateGeometryLocks } from "../src/main/pipeline/overlayOcrGeometryLocks";
import type { MangaPage } from "../src/shared/libraryTypes";

const page: MangaPage = {
  id: "page-1",
  name: "page.jpg",
  imagePath: "page.jpg",
  dataUrl: "",
  width: 1000,
  height: 1000,
  blocks: [],
  analysisStatus: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("OCR candidate geometry locks", () => {
  it("treats OCR no-text metadata as the page skip signal", () => {
    expect(
      isOcrResultNoTextDetected({
        hints: [],
        diagnostics: [],
        noTextDetected: true,
        textEvidenceCount: 0,
      }),
    ).toBe(true);
    expect(
      isOcrResultNoTextDetected({
        hints: [],
        diagnostics: [],
        noTextDetected: false,
        textEvidenceCount: 0,
      }),
    ).toBe(false);
    expect(isOcrResultNoTextDetected(null)).toBe(false);
  });

  it("locks a model item only to its matching candidate id", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 1,
          type: "nonsolid",
          bbox: { x: 104, y: 106, w: 88, h: 86 },
          jp: "jp",
          ko: "ko",
        },
      ],
      page,
      [{ id: 1, label: "text", x1: 100, y1: 100, x2: 200, y2: 200 }],
    );

    expect(result[0]?.bbox).toEqual({ x: 100, y: 100, w: 100, h: 100 });
  });

  it("does not move an item to a nearby candidate with a different id", () => {
    const originalBbox = { x: 510, y: 510, w: 70, h: 70 };
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 9,
          type: "nonsolid",
          bbox: originalBbox,
          jp: "jp",
          ko: "ko",
        },
      ],
      page,
      [
        { id: 1, label: "text", x1: 100, y1: 100, x2: 200, y2: 200 },
        { id: 2, label: "text", x1: 500, y1: 500, x2: 600, y2: 600 },
      ],
    );

    expect(result[0]?.bbox).toEqual(originalBbox);
  });

  it("preserves a bbox that merges same-container OCR candidates", () => {
    const mergedBbox = { x: 100, y: 100, w: 102, h: 180 };
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 2,
          type: "nonsolid",
          bbox: mergedBbox,
          jp: "ゴミはどいつもこいつも\n考えることが一緒だな！",
          ko: "쓰레기들은 하나같이 생각하는 게 똑같네!",
        },
      ],
      page,
      [
        {
          id: 1,
          label: "ocr_textline",
          x1: 100,
          y1: 100,
          x2: 150,
          y2: 280,
          groupId: "G001",
          containerType: "same_text_container",
        },
        {
          id: 2,
          label: "ocr_textline",
          x1: 152,
          y1: 100,
          x2: 202,
          y2: 280,
          groupId: "G001",
          containerType: "same_text_container",
        },
      ],
    );

    expect(result[0]?.bbox).toEqual(mergedBbox);
  });

  it("unions the exact OCR members selected by v10", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 6,
          candidateIds: [6, 4],
          type: "nonsolid",
          bbox: { x: 715, y: 174, w: 98, h: 105 },
          jp: "一つの領域の全文",
          ko: "한 영역의 전체 문장",
        },
      ],
      page,
      [
        { id: 6, x1: 820, y1: 124, x2: 830, y2: 139 },
        { id: 4, x1: 768, y1: 93, x2: 800, y2: 154 },
      ],
    );

    expect(result[0]?.bbox).toEqual({ x: 768, y: 93, w: 62, h: 61 });
  });

  it("rejects an unknown v10 candidate id", () => {
    expect(() =>
      applyOcrCandidateGeometryLocks(
        [
          {
            id: 1,
            candidateIds: [1, 99],
            type: "nonsolid",
            bbox: { x: 100, y: 100, w: 50, h: 50 },
            jp: "本文",
            ko: "본문",
          },
        ],
        page,
        [{ id: 1, x1: 100, y1: 100, x2: 150, y2: 150 }],
      ),
    ).toThrow(/unknown candidate id/i);
  });
});
