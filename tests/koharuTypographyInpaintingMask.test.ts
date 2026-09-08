import { describe, expect, it } from "vitest";
import type {
  ComicPageDetection,
  KoharuTypographySegmentation,
} from "../src/main/bubbleLayout/contracts";
import {
  buildKoharuTypographyCompositeMask,
  resolveKoharuTypographyCoreDilationPx,
  resolveKoharuTypographyFeatherPx,
} from "../src/main/inpainting/koharuTypographyMask";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import { buildPatternPageMask } from "../src/main/inpainting/patternPageMask";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("Koharu typography inpainting masks", () => {
  it("keeps a nearby excluded detection outside all selected-block Flux masks", () => {
    const page = { ...makePage(), width: 100, height: 100 };
    page.blocks[0] = {
      ...requireValue(page.blocks[0], "page block"),
      bbox: { x: 400, y: 400, w: 100, h: 100 },
      renderBbox: { x: 200, y: 200, w: 400, h: 400 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 1,
        origin: "manual",
        insetRatio: 0,
        regions: [
          {
            spans: [
              { blockStart: 0, blockEnd: 1, inlineStart: 0, inlineEnd: 1 },
            ],
          },
        ],
      },
    };
    const context = buildPatternPageMask({
      bitmap: Buffer.alloc(100 * 100 * 4, 255),
      bubbleLayoutConstraintBlockIds: ["block-1"],
      height: 100,
      width: 100,
      mode: "flux-region",
      page,
      typographySegmentation: {
        ...makeSegmentation([
          makeFilledDetection("text", 0, [40, 40, 50, 50]),
          makeFilledDetection("text", 0, [61, 40, 66, 45]),
        ]),
        imageWidth: 100,
        imageHeight: 100,
      },
    });
    for (const inventory of [
      context.inpaintWindowMasks,
      context.inpaintCompositeMasks,
      context.inpaintWindowConstraints,
    ]) {
      const mask = expandWindowMaskToPage(
        requireValue(inventory[0], "mask"),
        100,
        100,
      );
      expect(mask[42 * 100 + 63]).toBe(0);
      expect(mask[45 * 100 + 45]).toBe(1);
      for (let y = 0; y < 100; y += 1) {
        for (let x = 0; x < 100; x += 1) {
          if (x < 20 || x >= 60 || y < 20 || y >= 60)
            expect(mask[y * 100 + x]).toBe(0);
        }
      }
    }
  });

  it("lets Codex discover all text in a selected region even when segmentation misses it", () => {
    const page = makePage();
    page.blocks[0] = {
      ...page.blocks[0],
      bbox: { x: 125, y: 125, w: 750, h: 750 },
    };
    const options = {
      bitmap: Buffer.alloc(64 * 64 * 4, 255),
      height: 64,
      width: 64,
      page,
      mode: "flux-region" as const,
      typographySegmentation: makeSegmentation([
        makeFilledDetection("onomatopoeia", 1, [14, 14, 19, 46]),
        makeFilledDetection("onomatopoeia", 1, [44, 14, 49, 46]),
      ]),
    };
    const codex = buildPatternPageMask({ ...options, mode: "codex-region" });
    const model = expandWindowMaskToPage(
      requireValue(codex.inpaintWindowMasks[0], "model mask"),
      64,
      64,
    );
    const constraint = expandWindowMaskToPage(
      requireValue(codex.inpaintWindowConstraints[0], "constraint"),
      64,
      64,
    );
    expect(model[30 * 64 + 16]).toBe(1);
    expect(model[30 * 64 + 46]).toBe(1);
    expect(model[30 * 64 + 32]).toBe(1);
    expect(constraint[30 * 64 + 32]).toBe(1);
    expect(model).toEqual(constraint);
    const restyled = buildPatternPageMask({
      ...options,
      mode: "codex-region",
      page: {
        ...page,
        blocks: [{ ...page.blocks[0], fontSizePx: 180, outlineWidthPx: 50 }],
      },
    });
    expect(restyled.pageMask).toEqual(codex.pageMask);
    const legacy = buildPatternPageMask(options);
    expect(legacy.pageMask[30 * 64 + 32]).toBe(1);
    expect(() =>
      buildPatternPageMask({
        ...options,
        mode: "codex-region",
        typographySegmentation: undefined,
      }),
    ).not.toThrow();
  });
  it("builds a solid outlined-glyph core and a wider feather envelope", () => {
    const page = makePage();
    const block = page.blocks[0] as TranslationBlock;
    const segmentation = makeSegmentation([
      makeDetection("text", 0, [24, 24, 40, 40]),
      makeDetection("bubble", 2, [8, 8, 56, 56]),
    ]);

    const result = buildKoharuTypographyCompositeMask({
      block,
      featherPx: 8,
      height: 64,
      page,
      segmentation,
      sourceRect: { x: 24, y: 24, w: 16, h: 16 },
      width: 64,
    });

    const mask = requireValue(result, "Koharu typography mask");
    expect(mask.detectionCount).toBe(1);
    expect(mask.coreDilationPx).toBeGreaterThanOrEqual(4);
    const core = expandWindowMaskToPage(mask.core, 64, 64);
    const envelope = expandWindowMaskToPage(mask.featherEnvelope, 64, 64);
    expect(countMask(core)).toBeGreaterThan(16 * 16);
    expect(countMask(envelope)).toBeGreaterThan(countMask(core));
    expect(core.every((value, index) => !value || envelope[index] === 1)).toBe(
      true,
    );
  });

  it("keeps the model mask broad while binding final composite and validation to typography", () => {
    const page = makePage();
    const segmentation = makeSegmentation([
      makeDetection("text", 0, [25, 25, 39, 39]),
    ]);
    const context = buildPatternPageMask({
      bitmap: Buffer.alloc(64 * 64 * 4, 255),
      height: 64,
      mode: "flux-region",
      page,
      typographySegmentation: segmentation,
      width: 64,
    });

    expect(context.inpaintWindowMasks).toHaveLength(1);
    expect(context.inpaintCompositeMasks).toHaveLength(1);
    expect(context.inpaintWindowConstraints).toHaveLength(1);
    const model = expandWindowMaskToPage(
      requireValue(context.inpaintWindowMasks[0], "model mask"),
      64,
      64,
    );
    const composite = expandWindowMaskToPage(
      requireValue(context.inpaintCompositeMasks[0], "composite mask"),
      64,
      64,
    );
    const constraint = expandWindowMaskToPage(
      requireValue(context.inpaintWindowConstraints[0], "constraint mask"),
      64,
      64,
    );
    const validation = expandWindowMaskToPage(
      requireValue(context.validationWindowMasks[0], "validation mask"),
      64,
      64,
    );
    expect(countMask(model)).toBeGreaterThan(countMask(composite));
    expect(countMask(constraint)).toBeGreaterThan(countMask(composite));
    expect(composite).toEqual(validation);
    expect(
      composite.every((value, index) => !value || constraint[index] === 1),
    ).toBe(true);
  });

  it("keeps typography from both lobes of one constrained bubble in the final composite", () => {
    const page = makePage();
    page.blocks[0] = {
      ...requireValue(page.blocks[0], "page block"),
      bbox: { x: 375, y: 125, w: 250, h: 187.5 },
      renderBbox: { x: 250, y: 62.5, w: 500, h: 875 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 0.99,
        origin: "detected",
        modelId: "test-connected-bubble",
        sourceImageRevision: "test-revision",
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
    };
    const segmentation = makeSegmentation([
      makeFilledDetection("text", 0, [26, 10, 38, 20]),
      makeFilledDetection("text", 0, [26, 44, 38, 54]),
      makeFilledDetection("text", 0, [2, 44, 10, 54]),
    ]);

    const context = buildPatternPageMask({
      bitmap: Buffer.alloc(64 * 64 * 4, 255),
      bubbleLayoutConstraintBlockIds: ["block-1"],
      height: 64,
      mode: "flux-region",
      page,
      typographySegmentation: segmentation,
      width: 64,
    });
    const composite = expandWindowMaskToPage(
      requireValue(context.inpaintCompositeMasks[0], "composite mask"),
      64,
      64,
    );

    expect(composite[15 * 64 + 32]).toBe(1);
    expect(composite[49 * 64 + 32]).toBe(1);
    expect(composite[49 * 64 + 6]).toBe(0);
  });

  it("fails closed when detector and page dimensions drift", () => {
    const page = makePage();
    expect(() =>
      buildKoharuTypographyCompositeMask({
        block: requireValue(page.blocks[0], "page block"),
        featherPx: 8,
        height: 64,
        page,
        segmentation: { ...makeSegmentation([]), imageWidth: 63 },
        sourceRect: { x: 24, y: 24, w: 16, h: 16 },
        width: 64,
      }),
    ).toThrow("image size drifted");
  });

  it("expands thick outlined styles more than plain dialogue", () => {
    const block = requireValue(makePage().blocks[0], "page block");
    expect(
      resolveKoharuTypographyCoreDilationPx(
        {
          ...block,
          fontSizePx: 40,
          outlineWidthPx: 8,
        },
        makePage(),
      ),
    ).toBeGreaterThan(
      resolveKoharuTypographyCoreDilationPx(
        {
          ...block,
          fontSizePx: 20,
          outlineWidthPx: 0,
        },
        makePage(),
      ),
    );
  });

  it("scales feather width with page resolution instead of fixing it at 8px", () => {
    const block = requireValue(makePage().blocks[0], "page block");
    expect(
      resolveKoharuTypographyFeatherPx(block, { width: 2000, height: 2800 }),
    ).toBeGreaterThan(
      resolveKoharuTypographyFeatherPx(block, { width: 720, height: 1020 }),
    );
  });
});

function makeSegmentation(
  detections: ComicPageDetection[],
): KoharuTypographySegmentation {
  return { imageWidth: 64, imageHeight: 64, detections };
}

function makeDetection(
  label: ComicPageDetection["label"],
  labelId: ComicPageDetection["labelId"],
  box: ComicPageDetection["box"],
): ComicPageDetection {
  const logits = new Float32Array(8 * 8).fill(-10);
  for (let y = 3; y <= 4; y += 1) {
    for (let x = 3; x <= 4; x += 1) logits[y * 8 + x] = 10;
  }
  return {
    box,
    label,
    labelId,
    mask: { logits, width: 8, height: 8 },
    score: 0.99,
  };
}

function makeFilledDetection(
  label: ComicPageDetection["label"],
  labelId: ComicPageDetection["labelId"],
  box: ComicPageDetection["box"],
): ComicPageDetection {
  return {
    box,
    label,
    labelId,
    mask: {
      logits: new Float32Array(8 * 8).fill(10),
      width: 8,
      height: 8,
    },
    score: 0.99,
  };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "page.png",
    dataUrl: "",
    width: 64,
    height: 64,
    blocks: [
      {
        id: "block-1",
        type: "nonsolid",
        bbox: { x: 375, y: 375, w: 250, h: 250 },
        bboxSpace: "normalized_1000",
        sourceText: "テキスト",
        translatedText: "텍스트",
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontSizePx: 20,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#ffffff",
        opacity: 0,
      },
    ],
    analysisStatus: "idle",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

function countMask(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) count += value;
  return count;
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label}.`);
  }
  return value;
}
