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

  it("keeps a single-line membership lock exact", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 6,
          candidateIds: [6],
          type: "nonsolid",
          bbox: { x: 90, y: 90, w: 130, h: 130 },
          jp: "一行",
          ko: "한 줄",
          direction: "horizontal",
          fontSize: 24,
        },
      ],
      page,
      [{ id: 6, x1: 100, y1: 100, x2: 200, y2: 200 }],
    );

    expect(result[0]?.bbox).toEqual({ x: 100, y: 100, w: 100, h: 100 });
  });

  it("unions the exact OCR members selected by v10 without discarding the model bbox", () => {
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

    expect(result[0]?.bbox).toEqual({ x: 715, y: 93, w: 115, h: 186 });
  });

  it("preserves the model envelope and ungrouped OCR lines 22 and 24", () => {
    const tallPage = { ...page, height: 1421 };
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 22,
          type: "nonsolid",
          bbox: pixelsToNormalizedBbox(
            { x: 565, y: 961, w: 242, h: 79 },
            tallPage,
          ),
          jp: "ようこそ\n【Monster・Evolve・Online】\nの世界へ",
          ko: "몬스터 에볼브 온라인의 세계에 오신 것을 환영합니다",
          direction: "horizontal",
          fontSize: 22,
        },
      ],
      tallPage,
      [
        {
          id: 22,
          x1: 565,
          y1: 961,
          x2: 652,
          y2: 989,
          ocrText: "ようこそ",
        },
        {
          id: 24,
          x1: 565,
          y1: 1014,
          x2: 651,
          y2: 1040,
          ocrText: "の世界へ",
        },
      ],
    );

    const pixels = normalizedToPixelBbox(result[0]?.bbox, tallPage);
    expect(pixels.x).toBeCloseTo(561, 5);
    expect(pixels.y).toBeCloseTo(957, 5);
    expect(pixels.x + pixels.w).toBeCloseTo(811, 5);
    expect(pixels.y + pixels.h).toBeCloseTo(1044, 5);
  });

  it("preserves the ungrouped two-line OCR pair 25 and 26", () => {
    const tallPage = { ...page, height: 1421 };
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 25,
          type: "nonsolid",
          bbox: pixelsToNormalizedBbox(
            { x: 93, y: 1094, w: 163, h: 42 },
            tallPage,
          ),
          jp: "まずはあなたのことを教えてください",
          ko: "먼저 당신에 대해 알려 주세요",
          direction: "horizontal",
          fontSize: 18,
        },
      ],
      tallPage,
      [
        {
          id: 25,
          x1: 93,
          y1: 1094,
          x2: 209,
          y2: 1118,
          ocrText: "まずはあなたの",
        },
        {
          id: 26,
          x1: 94,
          y1: 1117,
          x2: 256,
          y2: 1136,
          ocrText: "ことを教えてください",
        },
      ],
    );

    const pixels = normalizedToPixelBbox(result[0]?.bbox, tallPage);
    expect(pixels.x).toBeCloseTo(89, 5);
    expect(pixels.y).toBeCloseTo(1090, 5);
    expect(pixels.x + pixels.w).toBeCloseTo(260, 5);
    expect(pixels.y + pixels.h).toBeCloseTo(1140, 5);
  });

  it("does not absorb an adjacent OCR hint owned by another balloon", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 22,
          type: "nonsolid",
          bbox: { x: 500, y: 500, w: 60, h: 60 },
          jp: "첫째 줄\n둘째 줄",
          ko: "첫째 줄 둘째 줄",
          direction: "horizontal",
          fontSize: 20,
        },
        {
          id: 30,
          type: "nonsolid",
          bbox: { x: 565, y: 528, w: 55, h: 25 },
          jp: "別の吹き出し",
          ko: "다른 말풍선",
          direction: "horizontal",
          fontSize: 20,
        },
      ],
      page,
      [
        {
          id: 22,
          x1: 500,
          y1: 500,
          x2: 550,
          y2: 522,
          ocrText: "첫째 줄",
        },
        {
          id: 24,
          x1: 500,
          y1: 532,
          x2: 555,
          y2: 554,
          ocrText: "둘째 줄",
        },
        {
          id: 30,
          x1: 565,
          y1: 528,
          x2: 620,
          y2: 553,
          ocrText: "別の吹き出し",
          groupId: "G900",
          containerType: "same_text_container",
        },
      ],
    );

    expect(result[0]?.bbox.x + (result[0]?.bbox.w ?? 0)).toBe(564);
    expect(result[1]?.bbox).toEqual({ x: 565, y: 528, w: 55, h: 25 });
  });

  it("does not absorb a non-representative candidate owned by another item", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 22,
          type: "nonsolid",
          bbox: { x: 500, y: 500, w: 80, h: 50 },
          jp: "同じ文\n同じ文",
          ko: "같은 문장",
          direction: "horizontal",
          fontSize: 20,
        },
        {
          id: 30,
          candidateIds: [30, 24],
          type: "nonsolid",
          bbox: { x: 500, y: 545, w: 70, h: 22 },
          jp: "同じ文",
          ko: "다른 블록",
          direction: "horizontal",
          fontSize: 20,
        },
      ],
      page,
      [
        {
          id: 22,
          x1: 500,
          y1: 500,
          x2: 555,
          y2: 522,
          ocrText: "同じ文",
        },
        {
          id: 24,
          x1: 500,
          y1: 545,
          x2: 570,
          y2: 567,
          ocrText: "同じ文",
        },
        {
          id: 30,
          x1: 500,
          y1: 545,
          x2: 570,
          y2: 567,
          ocrText: "同じ文",
        },
      ],
    );

    expect(result[0]?.bbox).toEqual({ x: 496, y: 496, w: 88, h: 58 });
    expect(result[1]?.bbox).toEqual({ x: 496, y: 541, w: 78, h: 30 });
  });

  it("keeps a plausible multiline model envelope when OCR found only one line", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 1,
          type: "nonsolid",
          bbox: { x: 100, y: 100, w: 160, h: 50 },
          jp: "一行目二行目",
          ko: "첫째 줄 둘째 줄",
          direction: "horizontal",
          fontSize: 20,
        },
      ],
      page,
      [
        {
          id: 1,
          x1: 100,
          y1: 100,
          x2: 180,
          y2: 122,
          ocrText: "一行目",
        },
      ],
    );

    expect(result[0]?.bbox).toEqual({ x: 96, y: 96, w: 168, h: 58 });
  });

  it("keeps a plausible multiline model envelope for one v10 candidate", () => {
    const tallPage = { ...page, height: 1421 };
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 22,
          candidateIds: [22],
          type: "nonsolid",
          bbox: pixelsToNormalizedBbox(
            { x: 565, y: 961, w: 242, h: 79 },
            tallPage,
          ),
          jp: "ようこそ",
          ko: "환영합니다",
          direction: "horizontal",
          fontSize: 22,
        },
      ],
      tallPage,
      [
        {
          id: 22,
          x1: 565,
          y1: 961,
          x2: 652,
          y2: 989,
          ocrText: "ようこそ",
        },
      ],
    );

    const pixels = normalizedToPixelBbox(result[0]?.bbox, tallPage);
    expect(pixels.x).toBeCloseTo(561, 5);
    expect(pixels.y).toBeCloseTo(957, 5);
    expect(pixels.x + pixels.w).toBeCloseTo(811, 5);
    expect(pixels.y + pixels.h).toBeCloseTo(1044, 5);
  });

  it("does not preserve an implausibly page-sized model box for multiline text", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 1,
          type: "nonsolid",
          bbox: { x: 30, y: 30, w: 900, h: 900 },
          jp: "一行目二行目",
          ko: "첫째 줄 둘째 줄",
          direction: "horizontal",
          fontSize: 20,
        },
      ],
      page,
      [
        {
          id: 1,
          x1: 100,
          y1: 100,
          x2: 180,
          y2: 124,
          ocrText: "一行目",
        },
      ],
    );

    expect(result[0]?.bbox.x).toBeGreaterThanOrEqual(96);
    expect(result[0]?.bbox.y).toBeGreaterThanOrEqual(87);
    expect(result[0]?.bbox.w).toBeLessThan(100);
    expect(result[0]?.bbox.h).toBeLessThan(60);
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

function pixelsToNormalizedBbox(
  bbox: { x: number; y: number; w: number; h: number },
  targetPage: Pick<MangaPage, "width" | "height">,
) {
  return {
    x: (bbox.x / targetPage.width) * 1000,
    y: (bbox.y / targetPage.height) * 1000,
    w: (bbox.w / targetPage.width) * 1000,
    h: (bbox.h / targetPage.height) * 1000,
  };
}

function normalizedToPixelBbox(
  bbox: { x: number; y: number; w: number; h: number } | undefined,
  targetPage: Pick<MangaPage, "width" | "height">,
) {
  if (!bbox) {
    throw new Error("expected bbox");
  }
  return {
    x: (bbox.x / 1000) * targetPage.width,
    y: (bbox.y / 1000) * targetPage.height,
    w: (bbox.w / 1000) * targetPage.width,
    h: (bbox.h / 1000) * targetPage.height,
  };
}
