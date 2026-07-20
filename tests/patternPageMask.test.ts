import { describe, expect, it } from "vitest";
import { bboxToPixelRect } from "../src/main/inpainting/maskGeometry";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import { buildPatternPageMask } from "../src/main/inpainting/patternPageMask";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("pattern page block-owned masks", () => {
  it("keeps nearby block masks separate when their inpaint windows overlap", () => {
    const width = 128;
    const height = 64;
    const page = createPage(width, height);
    const context = buildPatternPageMask({
      page,
      bitmap: Buffer.alloc(width * height * 4, 255),
      width,
      height,
      bubbleMask: new Uint8Array(width * height),
    });

    expect(context.inpaintWindows).toHaveLength(2);
    expect(context.inpaintWindowMasks).toHaveLength(2);
    expect(
      rectsOverlap(context.inpaintWindows[0], context.inpaintWindows[1]),
    ).toBe(true);

    const blockRects = page.blocks.map((block) =>
      bboxToPixelRect(block.bbox, page),
    );
    const centers = blockRects.map((rect) => ({
      x: rect.x + Math.floor(rect.w / 2),
      y: rect.y + Math.floor(rect.h / 2),
    }));
    const ownedPageMasks = context.inpaintWindowMasks.map((windowMask) =>
      expandWindowMaskToPage(windowMask, width, height),
    );

    expect(ownedPageMasks[0][centers[0].y * width + centers[0].x]).toBe(1);
    expect(ownedPageMasks[0][centers[1].y * width + centers[1].x]).toBe(0);
    expect(ownedPageMasks[1][centers[0].y * width + centers[0].x]).toBe(0);
    expect(ownedPageMasks[1][centers[1].y * width + centers[1].x]).toBe(1);
    expect(context.pageMask[centers[0].y * width + centers[0].x]).toBe(1);
    expect(context.pageMask[centers[1].y * width + centers[1].x]).toBe(1);
  });

  it("finishes smooth gradient text removal in the lightweight stage", () => {
    const width = 128;
    const height = 96;
    const page = createSingleBlockPage(width, height);
    const bitmap = createGradientBitmap(width, height);
    for (let y = 38; y < 58; y += 1) {
      for (let x = 54; x < 74; x += 1) {
        if (x % 5 < 2 || y % 7 < 2) writeRgb(bitmap, width, x, y, 0, 0, 0);
      }
    }

    const context = buildPatternPageMask({
      page,
      bitmap,
      width,
      height,
      bubbleMask: new Uint8Array(width * height),
    });

    expect(context).toMatchObject({
      blocksErased: 1,
      directFillBlocks: 0,
      lightweightFillBlocks: 1,
      engineBlocks: 0,
    });
    expect(context.inpaintWindows).toHaveLength(0);
    expect(readRgb(bitmap, width, 64, 48)).not.toEqual({ r: 0, g: 0, b: 0 });
  });
});

function createPage(width: number, height: number): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "page.png",
    dataUrl: "",
    width,
    height,
    blocks: [createBlock("block-1", 250), createBlock("block-2", 500)],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createSingleBlockPage(width: number, height: number): MangaPage {
  return {
    ...createPage(width, height),
    blocks: [
      {
        ...createBlock("block-gradient", 420),
        bbox: { x: 420, y: 360, w: 160, h: 280 },
      },
    ],
  };
}

function createGradientBitmap(width: number, height: number): Buffer {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      writeRgb(
        bitmap,
        width,
        x,
        y,
        90 + (60 * x) / (width - 1),
        110 + (30 * y) / (height - 1),
        150 - (20 * x) / (width - 1),
      );
    }
  }
  return bitmap;
}

function writeRgb(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
): void {
  const offset = (y * width + x) * 4;
  bitmap[offset] = Math.round(b);
  bitmap[offset + 1] = Math.round(g);
  bitmap[offset + 2] = Math.round(r);
  bitmap[offset + 3] = 255;
}

function readRgb(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
): { r: number; g: number; b: number } {
  const offset = (y * width + x) * 4;
  return {
    r: bitmap[offset + 2],
    g: bitmap[offset + 1],
    b: bitmap[offset],
  };
}

function createBlock(id: string, x: number): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x, y: 400, w: 50, h: 100 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 12,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

function rectsOverlap(
  left: { x: number; y: number; w: number; h: number },
  right: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    left.x < right.x + right.w &&
    left.x + left.w > right.x &&
    left.y < right.y + right.h &&
    left.y + left.h > right.y
  );
}
