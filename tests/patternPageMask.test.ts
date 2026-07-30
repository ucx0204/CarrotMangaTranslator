import { describe, expect, it } from "vitest";
import {
  bboxToPixelRect,
  expandRect,
  resolvePatternRegionPaddingPx,
} from "../src/main/inpainting/maskGeometry";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import { buildPatternPageMask } from "../src/main/inpainting/patternPageMask";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("pattern page text masks", () => {
  it("keeps block-owned masks separate for overlapping Metal windows", () => {
    const width = 128;
    const height = 64;
    const page = createPage(width, height);
    const context = buildPatternPageMask({
      page,
      bitmap: Buffer.alloc(width * height * 4, 255),
      width,
      height,
    });

    expect(context.blocksErased).toBe(2);
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

  it("limits the page mask to the requested block", () => {
    const width = 128;
    const height = 64;
    const page = createPage(width, height);
    const requestedBlock = page.blocks[1];
    if (!requestedBlock) {
      throw new Error("expected requested block");
    }
    requestedBlock.inpaintExcluded = true;
    const context = buildPatternPageMask({
      blockId: "block-2",
      page,
      bitmap: Buffer.alloc(width * height * 4, 255),
      width,
      height,
    });
    const blockRects = page.blocks.map((block) =>
      bboxToPixelRect(block.bbox, page),
    );
    const centers = blockRects.map((rect) => ({
      x: rect.x + Math.floor(rect.w / 2),
      y: rect.y + Math.floor(rect.h / 2),
    }));

    expect(context.blocksErased).toBe(1);
    expect(context.inpaintWindows).toHaveLength(1);
    expect(context.inpaintWindowMasks).toHaveLength(1);
    expect(context.pageMask[centers[0].y * width + centers[0].x]).toBe(0);
    expect(context.pageMask[centers[1].y * width + centers[1].x]).toBe(1);
  });

  it("passes a detected text mask directly to the engine window", () => {
    const width = 80;
    const height = 80;
    const block = createBlock("block-1", 375, {
      y: 375,
      w: 250,
      h: 250,
    });
    const page = createPage(width, height, [block]);
    const bitmap = Buffer.alloc(width * height * 4, 248);
    fillRect(bitmap, width, { x: 36, y: 32, w: 4, h: 16 }, 10);

    const context = buildPatternPageMask({ page, bitmap, width, height });
    const sourceRect = bboxToPixelRect(block.bbox, page);
    const ownedMask = expandWindowMaskToPage(
      context.inpaintWindowMasks[0],
      width,
      height,
    );

    expect(context.blocksErased).toBe(1);
    expect(context.inpaintWindowMasks[0]?.bounds.x).toBeLessThan(sourceRect.x);
    expect(ownedMask[40 * width + 38]).toBe(1);
    expect(ownedMask[sourceRect.y * width + sourceRect.x]).toBe(0);
  });

  it("uses a tight filled fallback when text detection finds no pixels", () => {
    const width = 80;
    const height = 80;
    const block = createBlock("block-1", 375, {
      y: 375,
      w: 250,
      h: 250,
    });
    const page = createPage(width, height, [block]);
    const bitmap = Buffer.alloc(width * height * 4, 255);
    const original = Buffer.from(bitmap);

    const context = buildPatternPageMask({ page, bitmap, width, height });
    const expectedBounds = expandRect(
      bboxToPixelRect(block.bbox, page),
      width,
      height,
      2,
    );
    const fallback = context.inpaintWindowMasks[0];

    expect(fallback?.bounds).toEqual(expectedBounds);
    expect(fallback?.data.every((value) => value === 1)).toBe(true);
    expect(context.pageMask.some((value) => value !== 0)).toBe(true);
    expect(bitmap).toEqual(original);
  });

  it("restores the legacy filled OCR support region for Flux without a bubble shape", () => {
    const width = 100;
    const height = 100;
    const block = createBlock("block-1", 300, {
      y: 300,
      w: 200,
      h: 240,
    });
    const page = createPage(width, height, [block]);
    const context = buildPatternPageMask({
      page,
      bitmap: Buffer.alloc(width * height * 4, 255),
      width,
      height,
      mode: "flux-region",
    });
    const expected = expandRect(
      bboxToPixelRect(block.bbox, page),
      width,
      height,
      resolvePatternRegionPaddingPx(block, page),
    );
    const constraint = context.inpaintWindowConstraints[0];

    expect(context.otsuBlocks).toBe(0);
    expect(context.inpaintWindowMasks[0]?.bounds).toEqual(expected);
    expect(constraint).toBeNull();
    expect(context.pageMask[expected.y * width + expected.x]).toBe(1);
    expect(
      context.pageMask[(expected.y + expected.h) * width + expected.x],
    ).toBe(0);
  });

  it("keeps legacy detected glyph fringe outside the filled Flux support region", () => {
    const width = 100;
    const height = 100;
    const block = createBlock("block-1", 300, {
      y: 300,
      w: 200,
      h: 240,
    });
    const page = createPage(width, height, [block]);
    const bitmap = Buffer.alloc(width * height * 4, 255);
    // The stroke starts inside the OCR box and extends past its 2px support
    // padding, matching furigana/punctuation that the old Flux mask retained.
    fillRect(bitmap, width, { x: 48, y: 40, w: 10, h: 4 }, 10);
    const context = buildPatternPageMask({
      page,
      bitmap,
      width,
      height,
      mode: "flux-region",
    });
    const support = expandRect(
      bboxToPixelRect(block.bbox, page),
      width,
      height,
      resolvePatternRegionPaddingPx(block, page),
    );

    expect(56).toBeGreaterThanOrEqual(support.x + support.w);
    expect(context.pageMask[42 * width + 56]).toBe(1);
    expect(context.inpaintWindowConstraints[0]).toBeNull();
  });

  it("uses only the green bubble region when Flux has usable shape geometry", () => {
    const width = 100;
    const height = 100;
    const block = {
      ...createBlock("block-1", 100, {
        y: 100,
        w: 800,
        h: 800,
      }),
      renderBbox: { x: 300, y: 300, w: 400, h: 400 },
      renderBboxSpace: "normalized_1000" as const,
      bubbleLayout: {
        version: 1 as const,
        direction: "horizontal" as const,
        confidence: 1,
        origin: "manual" as const,
        insetRatio: 0.08,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 1,
                inlineStart: 0.25,
                inlineEnd: 0.75,
              },
            ],
          },
        ],
      },
    };
    const page = createPage(width, height, [block]);
    const context = buildPatternPageMask({
      page,
      bitmap: Buffer.alloc(width * height * 4, 255),
      width,
      height,
      mode: "flux-region",
      bubbleLayoutConstraintBlockIds: [block.id],
    });
    const core = context.inpaintWindowMasks[0];
    const constraint = context.inpaintWindowConstraints[0];

    expect(core?.bounds).toEqual({ x: 30, y: 30, w: 40, h: 40 });
    expect(constraint).toBe(core);
    expect(context.pageMask[50 * width + 50]).toBe(1);
    // The oversized OCR bbox covers this point, but the authoritative green
    // region does not. A connected neighboring balloon must remain untouched.
    expect(context.pageMask[50 * width + 20]).toBe(0);
    expect(context.pageMask[50 * width + 39]).toBe(0);
    expect(context.pageMask[50 * width + 40]).toBe(1);
    expect(context.pageMask[50 * width + 59]).toBe(1);
    expect(context.pageMask[50 * width + 60]).toBe(0);
  });

  it("unions different masks from one detector conflict into one Flux window", () => {
    const width = 100;
    const height = 100;
    const makeSharedBlock = (
      id: string,
      renderBbox: { x: number; y: number; w: number; h: number },
    ) => ({
      ...createBlock(id, renderBbox.x),
      renderBbox,
      renderBboxSpace: "normalized_1000" as const,
      bubbleLayout: {
        version: 1 as const,
        direction: "horizontal" as const,
        confidence: 1,
        origin: "detected" as const,
        modelId: "comic-rtdetr-test",
        sourceImageRevision: `revision-${id}`,
        insetRatio: 0,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 1,
                inlineStart: 0,
                inlineEnd: 1,
              },
            ],
          },
        ],
      },
    });
    const left = makeSharedBlock("left", {
      x: 150,
      y: 250,
      w: 400,
      h: 400,
    });
    const right = makeSharedBlock("right", {
      x: 450,
      y: 300,
      w: 400,
      h: 300,
    });
    const page = createPage(width, height, [left, right]);

    const context = buildPatternPageMask({
      page,
      bitmap: Buffer.alloc(width * height * 4, 255),
      width,
      height,
      mode: "flux-region",
      bubbleLayoutConstraintBlockIds: [left.id, right.id],
      sharedInpaintGroupIdsByBlock: {
        [left.id]: ["shared-1"],
        [right.id]: ["shared-1"],
      },
    });

    expect(context.blocksErased).toBe(2);
    expect(context.inpaintWindows).toHaveLength(1);
    expect(context.inpaintWindowMasks).toHaveLength(1);
    expect(context.inpaintWindowConstraints).toHaveLength(1);
    expect(context.inpaintWindowGroupIds).toEqual([["shared-1"]]);
    expect(context.pageMask[40 * width + 20]).toBe(1);
    expect(context.pageMask[40 * width + 80]).toBe(1);
  });

  it("ignores persisted green geometry unless a zero-padding prepass enables it", () => {
    const width = 100;
    const height = 100;
    const block = {
      ...createBlock("block-1", 100, {
        y: 100,
        w: 800,
        h: 800,
      }),
      renderBbox: { x: 300, y: 300, w: 400, h: 400 },
      bubbleLayout: {
        version: 1 as const,
        direction: "horizontal" as const,
        confidence: 1,
        origin: "manual" as const,
        insetRatio: 0.08,
        regions: [
          {
            spans: [
              {
                blockStart: 0,
                blockEnd: 1,
                inlineStart: 0.25,
                inlineEnd: 0.75,
              },
            ],
          },
        ],
      },
    };
    const page = createPage(width, height, [block]);
    const context = buildPatternPageMask({
      page,
      bitmap: Buffer.alloc(width * height * 4, 255),
      width,
      height,
      mode: "flux-region",
    });

    expect(context.pageMask[50 * width + 20]).toBe(1);
    expect(context.inpaintWindowMasks[0]?.bounds).toEqual(
      expandRect(
        bboxToPixelRect(block.bbox, page),
        width,
        height,
        resolvePatternRegionPaddingPx(block, page),
      ),
    );
  });

  it("skips excluded and unusable blocks", () => {
    const width = 80;
    const height = 80;
    const included = createBlock("included", 250);
    const excluded = {
      ...createBlock("excluded", 500),
      inpaintExcluded: true,
    };
    const unusable = {
      ...createBlock("unusable", 750),
      bbox: { x: 750, y: 400, w: 0, h: 100 },
    };
    const page = createPage(width, height, [included, excluded, unusable]);

    const context = buildPatternPageMask({
      page,
      bitmap: Buffer.alloc(width * height * 4, 255),
      width,
      height,
    });

    expect(context.blocksErased).toBe(1);
    expect(context.inpaintWindows).toHaveLength(1);
    expect(context.inpaintWindowMasks).toHaveLength(1);
  });
});

function createPage(
  width: number,
  height: number,
  blocks: TranslationBlock[] = [
    createBlock("block-1", 250),
    createBlock("block-2", 500),
  ],
): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "page.png",
    dataUrl: "",
    width,
    height,
    blocks,
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createBlock(
  id: string,
  x: number,
  bbox: Partial<TranslationBlock["bbox"]> = {},
): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x, y: 400, w: 50, h: 100, ...bbox },
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

function fillRect(
  bitmap: Buffer,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
  value: number,
): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const offset = (y * width + x) * 4;
      bitmap[offset] = value;
      bitmap[offset + 1] = value;
      bitmap[offset + 2] = value;
      bitmap[offset + 3] = 255;
    }
  }
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
