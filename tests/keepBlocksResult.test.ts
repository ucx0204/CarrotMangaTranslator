import { describe, expect, it } from "vitest";
import { joinCropOcrTexts } from "../src/main/pipeline/keepBlocksOcr";
import {
  applyOverlayItemsToExistingBlocks,
  buildKeepBlocksOcrResult,
  shouldKeepExistingBlocks,
} from "../src/main/pipeline/keepBlocksResult";
import { buildPreviousBlocksForPrompt } from "../src/main/pipeline/previousBlocksForPrompt";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import type { OverlayItem } from "../src/main/pipeline/types";

describe("keep-blocks translation mode", () => {
  it("keeps existing blocks only when keep mode is on and blocks exist", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }),
    ]);
    expect(shouldKeepExistingBlocks("keep", page)).toBe(true);
    expect(shouldKeepExistingBlocks("auto", page)).toBe(false);
    expect(shouldKeepExistingBlocks(undefined, page)).toBe(false);
    expect(shouldKeepExistingBlocks("keep", makePage([]))).toBe(false);
  });

  it("synthesizes pixel-space OCR hints with sequential ids from blocks", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 200, w: 300, h: 100 }),
      makeBlock("b-2", { x: 500, y: 500, w: 100, h: 100 }),
    ]);
    const result = buildKeepBlocksOcrResult(page);
    expect(result.noTextDetected).toBe(false);
    expect(result.textEvidenceCount).toBe(2);
    expect(result.hints).toEqual([
      expect.objectContaining({ id: 1, x1: 100, y1: 300, x2: 400, y2: 450 }),
      expect.objectContaining({ id: 2, x1: 500, y1: 750, x2: 600, y2: 900 }),
    ]);
  });

  it("attaches per-block crop OCR texts to the synthetic hints", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 200, w: 300, h: 100 }),
      makeBlock("b-2", { x: 500, y: 500, w: 100, h: 100 }),
    ]);
    const result = buildKeepBlocksOcrResult(page, ["誰も!彼も!", undefined]);
    expect(result.hints[0]).toEqual(
      expect.objectContaining({ id: 1, ocrText: "誰も!彼も!" }),
    );
    expect(result.hints[1]).not.toHaveProperty("ocrText");
  });

  it("joins crop OCR texts in Japanese reading order and skips junk hints", () => {
    const joined = joinCropOcrTexts([
      { x1: 10, y1: 10, x2: 40, y2: 200, ocrText: "ばかり" },
      { x1: 100, y1: 10, x2: 130, y2: 200, ocrText: "その" },
      { x1: 55, y1: 10, x2: 85, y2: 200, ocrText: "女" },
      { x1: 55, y1: 10, x2: 85, y2: 200, ocrText: "   " },
      { ocrText: "좌표없음" },
      null,
    ]);
    expect(joined).toBe("その 女 ばかり");
  });

  it("orders same-column horizontal lines top to bottom", () => {
    const joined = joinCropOcrTexts([
      { x1: 10, y1: 60, x2: 200, y2: 90, ocrText: "二行目" },
      { x1: 12, y1: 10, x2: 198, y2: 40, ocrText: "一行目" },
    ]);
    expect(joined).toBe("一行目 二行目");
  });

  it("orders non-Japanese OCR left to right and then top to bottom", () => {
    const joined = joinCropOcrTexts(
      [
        { x1: 110, y1: 10, x2: 200, y2: 40, ocrText: "world" },
        { x1: 10, y1: 60, x2: 200, y2: 90, ocrText: "second line" },
        { x1: 10, y1: 10, x2: 100, y2: 40, ocrText: "Hello" },
      ],
      "en",
    );

    expect(joined).toBe("Hello world second line");
  });

  it("orders right-to-left OCR within each line", () => {
    const joined = joinCropOcrTexts(
      [
        { x1: 10, y1: 10, x2: 100, y2: 40, ocrText: "العالم" },
        { x1: 110, y1: 10, x2: 200, y2: 40, ocrText: "مرحبا" },
      ],
      "ar-SA",
    );

    expect(joined).toBe("مرحبا العالم");
  });

  it("omits the sound role hint for freshly drawn empty blocks", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }),
      makeBlock("b-2", { x: 500, y: 500, w: 100, h: 100 }, "쿵"),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    expect(previousBlocks[0].textRole).toBeUndefined();
    expect(previousBlocks[1].textRole).toBe("sound");
  });

  it("maps items to blocks by candidate id, preserving geometry and format", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }, "이전 번역"),
      makeBlock("b-2", { x: 500, y: 500, w: 100, h: 100 }),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const items: OverlayItem[] = [
      makeItem(2, { x: 510, y: 505, w: 90, h: 90 }, "こんにちは", "안녕하세요"),
      makeItem(1, { x: 105, y: 100, w: 195, h: 95 }, "ありがとう", "고마워"),
    ];

    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items,
      previousBlocks,
    });

    expect(mapping.updatedCount).toBe(2);
    expect(mapping.keptCount).toBe(0);
    expect(mapping.droppedItemCount).toBe(0);
    expect(mapping.blocks[0]).toMatchObject({
      id: "b-1",
      bbox: { x: 100, y: 100, w: 200, h: 100 },
      sourceText: "ありがとう",
      translatedText: "고마워",
      fontSizePx: 24,
    });
    expect(mapping.blocks[1]).toMatchObject({
      id: "b-2",
      sourceText: "こんにちは",
      translatedText: "안녕하세요",
    });
  });

  it("keeps unmatched blocks untouched and drops out-of-block items", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }, "기존 유지"),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const items: OverlayItem[] = [
      makeItem(7, { x: 800, y: 800, w: 100, h: 100 }, "無関係", "무관"),
    ];

    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items,
      previousBlocks,
    });

    expect(mapping.updatedCount).toBe(0);
    expect(mapping.keptCount).toBe(1);
    expect(mapping.droppedItemCount).toBe(1);
    expect(mapping.blocks[0].translatedText).toBe("기존 유지");
  });

  it("falls back to bbox overlap when the model returns an unknown id", () => {
    const page = makePage([
      makeBlock("b-1", { x: 100, y: 100, w: 200, h: 100 }),
    ]);
    const previousBlocks = buildPreviousBlocksForPrompt(page, [], {
      assignSequentialCandidateIds: true,
    });
    const items: OverlayItem[] = [
      makeItem(9, { x: 110, y: 105, w: 180, h: 90 }, "はい", "네"),
    ];

    const mapping = applyOverlayItemsToExistingBlocks({
      page,
      items,
      previousBlocks,
    });

    expect(mapping.updatedCount).toBe(1);
    expect(mapping.blocks[0].translatedText).toBe("네");
  });
});

function makePage(blocks: TranslationBlock[]): MangaPage {
  return {
    id: "page-1",
    name: "001.jpg",
    imagePath: "001.jpg",
    dataUrl: "",
    width: 1000,
    height: 1500,
    blocks,
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(
  id: string,
  bbox: TranslationBlock["bbox"],
  translatedText = "",
): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox,
    bboxSpace: "normalized_1000",
    sourceText: "",
    translatedText,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    rotationDeg: 0,
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    outlineColor: "#ffffff",
    backgroundColor: "#ffffff",
    opacity: 1,
    autoFitText: true,
  };
}

function makeItem(
  id: number,
  bbox: OverlayItem["bbox"],
  jp: string,
  ko: string,
): OverlayItem {
  return {
    id,
    type: "nonsolid",
    textRole: "ordinary",
    bbox,
    jp,
    ko,
    confidence: 0.95,
  };
}
