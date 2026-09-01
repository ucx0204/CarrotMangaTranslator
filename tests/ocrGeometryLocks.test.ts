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

  it("keeps a Hayai singleton immutable even when the model expands it", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 7,
          type: "solid",
          textRole: "sound",
          bbox: { x: 80, y: 70, w: 180, h: 240 },
          jp: "本文",
          ko: "본문",
        },
      ],
      page,
      [
        {
          id: 7,
          label: "text",
          x1: 100,
          y1: 100,
          x2: 200,
          y2: 300,
          ocrText: "本文",
          geometryLocked: true,
        },
      ],
    );

    expect(result[0]).toMatchObject({
      candidateIds: [7],
      textRole: "ordinary",
      bbox: { x: 100, y: 100, w: 100, h: 200 },
      sourceFontLineGeometry: {
        lines: [
          {
            candidateId: 7,
            bbox: { x: 100, y: 100, w: 100, h: 200 },
            sourceText: "本文",
          },
        ],
      },
    });
  });

  it("locks explicit singleton membership without admitting adjacent hints", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 99,
          candidateIds: [8],
          type: "solid",
          textRole: "sound",
          bbox: { x: 50, y: 50, w: 400, h: 400 },
          jp: "一列",
          ko: "별도",
        },
      ],
      page,
      [
        {
          id: 8,
          x1: 300,
          y1: 200,
          x2: 360,
          y2: 500,
          ocrText: "一列",
          geometryLocked: true,
        },
        {
          id: 9,
          x1: 370,
          y1: 200,
          x2: 430,
          y2: 500,
          ocrText: "別列",
          geometryLocked: true,
        },
      ],
    );

    expect(result[0]).toMatchObject({
      candidateIds: [8],
      textRole: "ordinary",
      bbox: { x: 300, y: 200, w: 60, h: 300 },
    });
    expect(
      result[0]?.sourceFontLineGeometry?.lines.map((line) => line.candidateId),
    ).toEqual([8]);
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

  it("strips model-authored source line geometry when no OCR hints exist", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 1,
          type: "nonsolid",
          bbox: { x: 100, y: 100, w: 100, h: 100 },
          jp: "原文",
          ko: "번역",
          sourceFontLineGeometry: {
            contractVersion: "source-font-line-geometry-v1",
            source: "ocr-geometry-lock",
            lines: [
              {
                candidateId: 99,
                bbox: { x: 0, y: 0, w: 1000, h: 1000 },
                sourceText: "偽造",
              },
            ],
          },
        },
      ],
      page,
      [],
    );

    expect(result[0]?.sourceFontLineGeometry).toBeUndefined();
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

  it("restores a real four-line vertical model envelope split across reviewed OCR groups", () => {
    const sourcePage = { ...page, width: 844, height: 1200 };
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 1,
          type: "nonsolid",
          bbox: pixelsToNormalizedBbox(
            { x: 650, y: 750, w: 112, h: 215 },
            sourcePage,
          ),
          jp: "じつはね クッキーを 焼いてみたんだけど 食べてくれるかな？",
          ko: "실은 말이야, 쿠키를 구워 봤는데 먹어 줄래?",
          direction: "vertical",
          fontSize: 27,
        },
      ],
      sourcePage,
      [
        {
          id: 1,
          x1: 731,
          y1: 750,
          x2: 762,
          y2: 830,
          ocrText: "じつはね",
          groupId: "G001",
          containerType: "same_text_container",
        },
        {
          id: 4,
          x1: 697,
          y1: 801,
          x2: 721,
          y2: 898,
          ocrText: "クッキーを",
          groupId: "G002",
          containerType: "same_text_container",
        },
        {
          id: 3,
          x1: 673,
          y1: 798,
          x2: 701,
          y2: 965,
          ocrText: "焼いてみたんだけど",
          groupId: "G002",
          containerType: "same_text_container",
        },
        {
          id: 2,
          x1: 650,
          y1: 797,
          x2: 679,
          y2: 965,
          ocrText: "食べてくれるかな？",
          groupId: "G002",
          containerType: "same_text_container",
        },
      ],
    );

    const pixels = normalizedToPixelBbox(result[0]?.bbox, sourcePage);
    expect(pixels.x).toBeCloseTo(645, 5);
    expect(pixels.y).toBeCloseTo(745, 5);
    expect(pixels.x + pixels.w).toBeCloseTo(767, 5);
    expect(pixels.y + pixels.h).toBeCloseTo(970, 5);
    expect(
      result[0]?.sourceFontLineGeometry?.lines
        .map((line) => line.candidateId)
        .sort((left, right) => left - right),
    ).toEqual([1, 2, 3, 4]);
  });

  it("restores a real detached leading glyph with its three model-envelope lines", () => {
    const sourcePage = { ...page, width: 844, height: 1200 };
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 4,
          type: "nonsolid",
          bbox: pixelsToNormalizedBbox(
            { x: 119, y: 170, w: 99, h: 140 },
            sourcePage,
          ),
          jp: "皆 お兄様みたいに できない僕は ダメだって…",
          ko: "다들 형님처럼 해내지 못하는 나는 글렀다고…",
          direction: "vertical",
          fontSize: 24,
        },
      ],
      sourcePage,
      [
        { id: 4, x1: 190, y1: 170, x2: 218, y2: 202, ocrText: "皆" },
        {
          id: 6,
          x1: 167,
          y1: 171,
          x2: 193,
          y2: 310,
          ocrText: "お兄様みたいに",
          groupId: "G002",
          containerType: "same_text_container",
        },
        {
          id: 5,
          x1: 142,
          y1: 171,
          x2: 171,
          y2: 294,
          ocrText: "できない僕は",
          groupId: "G002",
          containerType: "same_text_container",
        },
        {
          id: 3,
          x1: 119,
          y1: 170,
          x2: 146,
          y2: 294,
          ocrText: "ダメだって…",
          groupId: "G002",
          containerType: "same_text_container",
        },
      ],
    );

    const pixels = normalizedToPixelBbox(result[0]?.bbox, sourcePage);
    expect(pixels.x).toBeCloseTo(114, 5);
    expect(pixels.y).toBeCloseTo(165, 5);
    expect(pixels.x + pixels.w).toBeCloseTo(223, 5);
    expect(pixels.y + pixels.h).toBeCloseTo(315, 5);
  });

  it("restores a real detached prefix with the remaining vertical source lines", () => {
    const sourcePage = { ...page, width: 844, height: 1200 };
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 13,
          type: "nonsolid",
          bbox: pixelsToNormalizedBbox(
            { x: 95, y: 787, w: 94, h: 186 },
            sourcePage,
          ),
          jp: "…いや 今でいい とりあえず 話は外で聞こう",
          ko: "…아니, 지금이면 돼. 일단 이야기는 밖에서 듣자.",
          direction: "vertical",
          fontSize: 22,
        },
      ],
      sourcePage,
      [
        { id: 13, x1: 165, y1: 787, x2: 189, y2: 850, ocrText: "…いや" },
        {
          id: 14,
          x1: 140,
          y1: 788,
          x2: 168,
          y2: 865,
          ocrText: "今でいい",
          groupId: "G008",
          containerType: "same_text_container",
        },
        { id: 17, x1: 121, y1: 843, x2: 142, y2: 973, ocrText: "とりあえず" },
        {
          id: 16,
          x1: 95,
          y1: 842,
          x2: 121,
          y2: 973,
          ocrText: "話は外で聞こう",
        },
      ],
    );

    const pixels = normalizedToPixelBbox(result[0]?.bbox, sourcePage);
    expect(pixels.x).toBeCloseTo(91, 5);
    expect(pixels.y).toBeCloseTo(783, 5);
    expect(pixels.x + pixels.w).toBeCloseTo(193, 5);
    expect(pixels.y + pixels.h).toBeCloseTo(977, 5);
  });

  it("keeps genuinely tiny repeated text local instead of absorbing a distant match", () => {
    const sourcePage = { ...page, width: 844, height: 1200 };
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 14,
          type: "nonsolid",
          bbox: pixelsToNormalizedBbox(
            { x: 36, y: 1101, w: 19, h: 83 },
            sourcePage,
          ),
          jp: "ごめんなさい…",
          ko: "미안해요…",
          direction: "vertical",
          fontSize: 14,
        },
      ],
      sourcePage,
      [
        {
          id: 12,
          x1: 645,
          y1: 1034,
          x2: 669,
          y2: 1151,
          ocrText: "ごめんなさい…",
        },
        {
          id: 13,
          x1: 667,
          y1: 1036,
          x2: 689,
          y2: 1150,
          ocrText: "ごめんなさい…",
        },
        {
          id: 14,
          x1: 36,
          y1: 1101,
          x2: 55,
          y2: 1184,
          ocrText: "ごめんなさい…",
        },
      ],
    );

    const pixels = normalizedToPixelBbox(result[0]?.bbox, sourcePage);
    expect(pixels).toEqual({ x: 36, y: 1101, w: 19, h: 83 });
  });

  it("does not bridge a mismatched representative id to a distant matching line", () => {
    const sourcePage = { ...page, width: 844, height: 1200 };
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 4,
          type: "nonsolid",
          bbox: pixelsToNormalizedBbox(
            { x: 736.56, y: 992.256, w: 62.64, h: 188.928 },
            sourcePage,
          ),
          jp: "ぐあっ！",
          ko: "크악!",
          direction: "vertical",
          fontSize: 72,
        },
      ],
      sourcePage,
      [
        {
          id: 4,
          x1: 756,
          y1: 529,
          x2: 840,
          y2: 912,
          ocrText: "聖位障壁！",
        },
        {
          id: 5,
          x1: 737,
          y1: 992,
          x2: 799,
          y2: 1181,
          ocrText: "ぐあっ！",
        },
      ],
    );

    const pixels = normalizedToPixelBbox(result[0]?.bbox, sourcePage);
    expect(pixels.x).toBeCloseTo(756, 5);
    expect(pixels.y).toBeCloseTo(529, 5);
    expect(pixels.w).toBeCloseTo(84, 5);
    expect(pixels.h).toBeCloseTo(383, 5);
  });

  it("exposes only the base line and excludes ruby source-size voters", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 27,
          type: "nonsolid",
          bbox: { x: 100, y: 100, w: 220, h: 90 },
          jp: "れん 紅蓮の迷宮 めい きゅ ぐ",
          ko: "홍련의 미궁",
          direction: "horizontal",
          fontSize: 40,
        },
      ],
      page,
      [
        {
          id: 27,
          x1: 100,
          y1: 130,
          x2: 320,
          y2: 175,
          ocrText: "紅蓮の迷宮",
          groupId: "G006",
          containerType: "same_text_container",
        },
        {
          id: 23,
          x1: 120,
          y1: 105,
          x2: 155,
          y2: 122,
          ocrText: "れん",
          groupId: "G006",
          containerType: "same_text_container",
        },
        {
          id: 25,
          x1: 175,
          y1: 105,
          x2: 210,
          y2: 122,
          ocrText: "めい",
          groupId: "G006",
          containerType: "same_text_container",
        },
        {
          id: 26,
          x1: 225,
          y1: 105,
          x2: 260,
          y2: 122,
          ocrText: "きゅ",
          groupId: "G006",
          containerType: "same_text_container",
        },
        {
          id: 24,
          x1: 275,
          y1: 105,
          x2: 295,
          y2: 122,
          ocrText: "ぐ",
          groupId: "G006",
          containerType: "same_text_container",
        },
      ],
    );

    expect(
      result[0]?.sourceFontLineGeometry?.lines.map((line) => line.candidateId),
    ).toEqual([27]);
  });

  it("keeps a local OCR line voter across one CJK recognition substitution", () => {
    const result = applyOcrCandidateGeometryLocks(
      [
        {
          id: 10,
          type: "nonsolid",
          bbox: { x: 264, y: 438, w: 81, h: 37 },
          jp: "経験値 3815",
          ko: "경험치 3815",
          direction: "horizontal",
          fontSize: 21,
        },
      ],
      page,
      [
        {
          id: 10,
          x1: 264,
          y1: 438,
          x2: 345,
          y2: 475,
          ocrText: "経験值",
        },
      ],
    );

    expect(result[0]?.sourceFontLineGeometry?.lines).toEqual([
      {
        candidateId: 10,
        bbox: { x: 264, y: 438, w: 81, h: 37 },
        sourceText: "経験值",
      },
    ]);
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
