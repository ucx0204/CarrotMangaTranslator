import { describe, expect, it } from "vitest";
import { prepareFontMatchingBlockViews } from "../src/main/pipeline/fontMatchingPagePixelPreprocessing";

describe("font matching raw glyph morphology", () => {
  it("matches the sealed Otsu, area-3, 8-CC and L2-mask5 contract", () => {
    const raster = grayscaleRaster(9, 9, 240);
    paintGray(raster, 3, 3, 3, 3, 20);
    paintGray(raster, 0, 0, 1, 1, 20);
    paintGray(raster, 8, 8, 1, 1, 20);

    const prepared = prepareFontMatchingBlockViews(raster, {
      x: 0,
      y: 0,
      w: 1000,
      h: 1000,
    });

    expect(prepared?.glyphMorphology).toMatchObject({
      contractVersion: "font-matching-glyph-morphology-v1",
      maskSource: "raw_grayscale_otsu_minority_area3",
      distanceTransform: "opencv_dist_l2_mask5",
      connectivity: 8,
      maskWidth: 9,
      maskHeight: 9,
      otsuThreshold: 20,
      foregroundPolarity: "dark",
      foregroundPixelCount: 9,
      connectedComponentCount: 1,
      medianComponentFill: 1,
      foregroundMeanLuma: 20,
    });
    expect(prepared?.glyphMorphology.globalForegroundDistanceMean).toBeCloseTo(
      10 / 9,
      6,
    );
    expect(prepared?.glyphMorphology.medianComponentDistanceMean).toBeCloseTo(
      10 / 9,
      6,
    );
    expect(prepared?.glyphMorphology.backgroundMeanLuma).toBeCloseTo(
      16840 / 72,
      6,
    );
  });

  it("keeps diagonal strokes as one 8-connected component", () => {
    const raster = grayscaleRaster(5, 5, 240);
    paintGray(raster, 1, 1, 1, 1, 20);
    paintGray(raster, 2, 2, 1, 1, 20);
    paintGray(raster, 3, 3, 1, 1, 20);

    const prepared = prepareFontMatchingBlockViews(raster, {
      x: 0,
      y: 0,
      w: 1000,
      h: 1000,
    });

    expect(prepared?.glyphMorphology).toMatchObject({
      foregroundPixelCount: 3,
      connectedComponentCount: 1,
      globalForegroundDistanceMean: 1,
      medianComponentDistanceMean: 1,
      medianComponentFill: 1 / 3,
    });
  });

  it("records light glyph polarity and luminance without changing the view contract", () => {
    const raster = grayscaleRaster(9, 9, 20);
    paintGray(raster, 3, 3, 3, 3, 240);

    const prepared = prepareFontMatchingBlockViews(raster, {
      x: 0,
      y: 0,
      w: 1000,
      h: 1000,
    });

    expect(prepared?.pixelValues.length).toBe(3 * 3 * 224 * 224);
    expect(prepared?.glyphMorphology).toMatchObject({
      foregroundPolarity: "light",
      foregroundMeanLuma: 240,
      backgroundMeanLuma: 20,
    });
  });
});

function grayscaleRaster(width: number, height: number, value: number) {
  const bgra = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    bgra[offset] = value;
    bgra[offset + 1] = value;
    bgra[offset + 2] = value;
    bgra[offset + 3] = 255;
  }
  return { width, height, bgra };
}

function paintGray(
  raster: ReturnType<typeof grayscaleRaster>,
  x1: number,
  y1: number,
  width: number,
  height: number,
  value: number,
): void {
  for (let y = y1; y < y1 + height; y += 1) {
    for (let x = x1; x < x1 + width; x += 1) {
      const offset = (y * raster.width + x) * 4;
      raster.bgra[offset] = value;
      raster.bgra[offset + 1] = value;
      raster.bgra[offset + 2] = value;
    }
  }
}
