import { describe, expect, it } from "vitest";
import { estimateSourceFontSizeForItem } from "../src/main/pipeline/sourceFontSizeEstimator";
import type { FontMatchingRasterPage } from "../src/main/pipeline/fontMatchingPagePixelPreprocessing";
import type { OverlayItem } from "../src/main/pipeline/types";

describe("source font-size raster estimator", () => {
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
