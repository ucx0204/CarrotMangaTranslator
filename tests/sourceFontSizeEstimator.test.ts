import { describe, expect, it, vi } from "vitest";
import {
  estimatePageSourceFontSizes,
  estimateSourceFontSizeForItem,
} from "../src/main/pipeline/sourceFontSizeEstimator";
import type { FontMatchingRasterPage } from "../src/main/pipeline/fontMatchingPagePixelPreprocessing";
import type { OverlayItem } from "../src/main/pipeline/types";

describe("source font-size raster estimator", () => {
  it("skips raster loading when source-size fitting is disabled", async () => {
    const loadRaster = vi.fn(async () =>
      createRaster(100, 30, () => undefined),
    );

    await expect(
      estimatePageSourceFontSizes({
        enabled: false,
        items: [makeItem()],
        page: { id: "page-disabled", width: 100, height: 30 } as never,
        loadRaster,
      }),
    ).resolves.toEqual([]);
    expect(loadRaster).not.toHaveBeenCalled();
  });

  it("measures a clean ordinary source line and returns an auditable face", () => {
    const raster = createRaster(100, 30, (setBlack) => {
      for (let glyph = 0; glyph < 4; glyph += 1) {
        fillRect(setBlack, 5 + glyph * 23, 5, 12, 20);
      }
    });

    const estimate = estimateSourceFontSizeForItem(
      raster,
      makeItem({ sourceText: "原文文字", jp: "原文文字" }),
    );

    expect(estimate?.method).toBe("raster-core-v1");
    expect(estimate?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(estimate?.facePx).toBeGreaterThan(18);
    expect(estimate?.facePx).toBeLessThan(24);
  });

  it("abstains for sound effects and strongly rotated ordinary text", () => {
    const raster = createRaster(100, 30, (setBlack) => {
      fillRect(setBlack, 5, 5, 80, 20);
    });

    expect(
      estimateSourceFontSizeForItem(raster, makeItem({ textRole: "sound" })),
    ).toBeUndefined();
    expect(
      estimateSourceFontSizeForItem(raster, makeItem({ angle: 9 })),
    ).toBeUndefined();
  });

  it("abstains when background texture creates too many components", () => {
    const raster = createRaster(100, 30, (setBlack) => {
      for (let index = 0; index < 24; index += 1) {
        fillRect(
          setBlack,
          2 + (index % 12) * 8,
          2 + Math.floor(index / 12) * 15,
          2,
          2,
        );
      }
    });

    expect(
      estimateSourceFontSizeForItem(
        raster,
        makeItem({ sourceText: "原文", jp: "原文" }),
      ),
    ).toBeUndefined();
  });

  it("uses robust OCR-line measurements when a merged crop is noisy", () => {
    const raster = createRaster(200, 100, (setBlack) => {
      for (let glyph = 0; glyph < 4; glyph += 1) {
        fillRect(setBlack, 5 + glyph * 23, 5, 12, 20);
        fillRect(setBlack, 105 + glyph * 23, 75, 12, 20);
      }
      for (let index = 0; index < 80; index += 1) {
        fillRect(
          setBlack,
          2 + (index % 20) * 10,
          36 + Math.floor(index / 20) * 8,
          2,
          2,
        );
      }
    });
    const merged = makeItem({
      sourceText: "原文文字原文文字",
      jp: "原文文字原文文字",
      bbox: { x: 0, y: 0, w: 1000, h: 1000 },
    });

    expect(estimateSourceFontSizeForItem(raster, merged)).toBeUndefined();
    const estimate = estimateSourceFontSizeForItem(raster, {
      ...merged,
      sourceFontLineGeometry: {
        contractVersion: "source-font-line-geometry-v1",
        source: "ocr-geometry-lock",
        lines: [
          {
            candidateId: 1,
            bbox: { x: 0, y: 0, w: 500, h: 300 },
            sourceText: "原文文字",
          },
          {
            candidateId: 2,
            bbox: { x: 500, y: 700, w: 500, h: 300 },
            sourceText: "原文文字",
          },
        ],
      },
    });

    expect(estimate?.method).toBe("raster-core-v1");
    expect(estimate?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(estimate?.facePx).toBeGreaterThan(18);
    expect(estimate?.facePx).toBeLessThan(24);
  });

  it("uses one exact OCR line when the merged source glyph count is contradictory", () => {
    const raster = createRaster(100, 30, (setBlack) => {
      for (let glyph = 0; glyph < 4; glyph += 1) {
        fillRect(setBlack, 5 + glyph * 23, 5, 12, 20);
      }
    });
    const merged = makeItem({
      sourceText: "原文文字1234",
      jp: "原文文字1234",
    });
    const mergedEstimate = estimateSourceFontSizeForItem(raster, merged);
    const lineEstimate = estimateSourceFontSizeForItem(raster, {
      ...merged,
      sourceFontLineGeometry: {
        contractVersion: "source-font-line-geometry-v1",
        source: "ocr-geometry-lock",
        lines: [
          {
            candidateId: 1,
            bbox: { x: 0, y: 0, w: 1000, h: 1000 },
            sourceText: "原文文字",
          },
        ],
      },
    });

    expect(mergedEstimate?.facePx).toBeLessThan(16);
    expect(lineEstimate?.facePx).toBeGreaterThan(18);
    expect(lineEstimate?.facePx).toBeLessThan(24);
  });

  it("measures only code-authorized source-size voters", () => {
    const raster = createRaster(200, 60, (setBlack) => {
      for (let glyph = 0; glyph < 4; glyph += 1) {
        fillRect(setBlack, 5 + glyph * 23, 5, 12, 20);
        fillRect(setBlack, 105 + glyph * 23, 40, 12, 10);
      }
    });
    const estimate = estimateSourceFontSizeForItem(raster, {
      ...makeItem({
        sourceText: "原文文字注釈文字",
        jp: "原文文字注釈文字",
        bbox: { x: 0, y: 0, w: 1000, h: 1000 },
      }),
      sourceCandidateMembership: {
        contractVersion: "font-matching-ocr-candidate-membership-v2",
        source: "semantic_ocr_fixed_block_request_v6",
        bindingId: "test-membership",
        originalCandidateIds: [1, 2],
        voterCandidateIds: [1],
      },
      sourceFontLineGeometry: {
        contractVersion: "source-font-line-geometry-v1",
        source: "ocr-geometry-lock",
        lines: [
          {
            candidateId: 1,
            bbox: { x: 0, y: 0, w: 500, h: 500 },
            sourceText: "原文文字",
          },
          {
            candidateId: 2,
            bbox: { x: 500, y: 500, w: 500, h: 500 },
            sourceText: "注釈文字",
          },
        ],
      },
    });

    expect(estimate?.facePx).toBeGreaterThan(18);
    expect(estimate?.facePx).toBeLessThan(24);
  });
});

function makeItem(overrides: Partial<OverlayItem> = {}): OverlayItem {
  return {
    id: 1,
    type: "nonsolid",
    textRole: "ordinary",
    bbox: { x: 0, y: 0, w: 1000, h: 1000 },
    jp: "原文文字",
    ko: "번역문",
    sourceText: "原文文字",
    translatedText: "번역문",
    direction: "horizontal",
    angle: 0,
    confidence: 1,
    ...overrides,
  };
}

function createRaster(
  width: number,
  height: number,
  draw: (setBlack: (x: number, y: number) => void) => void,
): FontMatchingRasterPage {
  const bgra = new Uint8Array(width * height * 4).fill(255);
  draw((x, y) => {
    const offset = (y * width + x) * 4;
    bgra[offset] = 0;
    bgra[offset + 1] = 0;
    bgra[offset + 2] = 0;
    bgra[offset + 3] = 255;
  });
  return { width, height, bgra };
}

function fillRect(
  setBlack: (x: number, y: number) => void,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) setBlack(x, y);
  }
}
