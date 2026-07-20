import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  buildBubbleConstraintMask,
  buildLightweightBubbleMask,
  refinePreciseBubbleMask,
  resolveBubbleIdForRect,
} from "../src/main/inpainting/bubbleMaskDetection";

describe("bubble mask detection", () => {
  it("detects a flat speech bubble and leaves its outline outside the mask", () => {
    const page = createPage(80, 80, [createBlock("one", 31, 31, 18, 18)]);
    const bitmap = createBitmap(80, 80, 130);
    fillRect(bitmap, 80, { x: 15, y: 18, w: 50, h: 44 }, 248);
    drawRectOutline(bitmap, 80, { x: 14, y: 17, w: 52, h: 46 }, 10);
    fillRect(bitmap, 80, { x: 35, y: 30, w: 4, h: 20 }, 15);
    fillRect(bitmap, 80, { x: 43, y: 30, w: 4, h: 20 }, 15);

    const result = buildLightweightBubbleMask(bitmap, page);

    expect(result.matchedBlocks).toBe(1);
    expect(result.mask[25 * 80 + 25]).toBeGreaterThan(0);
    expect(result.mask[17 * 80 + 40]).toBe(0);
    expect(result.mask[8 * 80 + 8]).toBe(0);
  });

  it("splits a conjoined precise segment by the nearest OCR block", () => {
    const page = createPage(64, 40, [
      createBlock("left", 10, 12, 12, 14),
      createBlock("right", 42, 12, 12, 14),
    ]);
    const preciseMask = new Uint8Array(64 * 40);
    for (let y = 5; y < 35; y += 1) {
      preciseMask.fill(1, y * 64 + 4, y * 64 + 60);
    }

    const result = refinePreciseBubbleMask(
      preciseMask,
      createBitmap(64, 40, 245),
      page,
    );

    const leftId = result.mask[20 * 64 + 12];
    const rightId = result.mask[20 * 64 + 52];
    expect(result.splitRegions).toBe(1);
    expect(leftId).toBeGreaterThan(0);
    expect(rightId).toBeGreaterThan(0);
    expect(leftId).not.toBe(rightId);
  });

  it("erodes the selected segment to protect its outline", () => {
    const mask = new Uint8Array(20 * 20);
    for (let y = 3; y < 17; y += 1) {
      mask.fill(7, y * 20 + 3, y * 20 + 17);
    }
    const rect = { x: 0, y: 0, w: 20, h: 20 };
    expect(resolveBubbleIdForRect(mask, 20, rect)).toBe(7);

    const constraint = buildBubbleConstraintMask(mask, 20, 20, rect, 7, 2);
    expect(constraint[10 * 20 + 10]).toBe(1);
    expect(constraint[3 * 20 + 10]).toBe(0);
    expect(constraint[5 * 20 + 10]).toBe(1);
  });
});

function createPage(
  width: number,
  height: number,
  blocks: TranslationBlock[],
): MangaPage {
  return {
    id: "page",
    name: "page.png",
    imagePath: "page.png",
    dataUrl: "",
    width,
    height,
    blocks: blocks.map((block) => ({
      ...block,
      bbox: {
        x: (block.bbox.x / width) * 1000,
        y: (block.bbox.y / height) * 1000,
        w: (block.bbox.w / width) * 1000,
        h: (block.bbox.h / height) * 1000,
      },
      bboxSpace: "normalized_1000",
    })),
    analysisStatus: "idle",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function createBlock(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x, y, w, h },
    bboxSpace: "pixels",
    sourceText: "text",
    translatedText: "",
    confidence: 1,
    sourceDirection: "vertical",
    renderDirection: "vertical",
    fontSizePx: 16,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

function createBitmap(width: number, height: number, value: number): Buffer {
  const bitmap = Buffer.alloc(width * height * 4);
  fillRect(bitmap, width, { x: 0, y: 0, w: width, h: height }, value);
  return bitmap;
}

function fillRect(
  bitmap: Buffer,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
  value: number,
): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      writePixel(bitmap, width, x, y, value);
    }
  }
}

function drawRectOutline(
  bitmap: Buffer,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
  value: number,
): void {
  fillRect(bitmap, width, { ...rect, h: 1 }, value);
  fillRect(bitmap, width, { ...rect, y: rect.y + rect.h - 1, h: 1 }, value);
  fillRect(bitmap, width, { ...rect, w: 1 }, value);
  fillRect(bitmap, width, { ...rect, x: rect.x + rect.w - 1, w: 1 }, value);
}

function writePixel(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
  value: number,
): void {
  const offset = (y * width + x) * 4;
  bitmap[offset] = value;
  bitmap[offset + 1] = value;
  bitmap[offset + 2] = value;
  bitmap[offset + 3] = 255;
}
