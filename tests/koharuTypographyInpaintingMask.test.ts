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
