import { describe, expect, it } from "vitest";
import {
  createIdentityWarpPoints,
  createIdentityWarpTransform,
  createInverseWarpEvaluator,
  createWarpEvaluator,
  createWarpPreset,
  isIdentityWarpTransform,
  isValidWarpTransform,
  resetWarpPointIndexes,
  resampleWarpTransform,
  validateWarpTransform,
  WARP_PRESET_NAMES,
} from "../src/shared/blockTransforms";
import {
  createWarpDisplacementPixels,
  resolveWarpMapRasterSize,
} from "../src/renderer/src/lib/warpDisplacementMap";
import { TranslationBlockSchema } from "../src/shared/ipcSchemaPrimitives";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("mesh warp transforms", () => {
  it.each([3, 5] as const)(
    "builds a valid identity %sx%s cell lattice",
    (gridSize) => {
      const transform = createIdentityWarpTransform(gridSize);
      expect(transform.points).toHaveLength((gridSize + 1) ** 2);
      expect(isIdentityWarpTransform(transform)).toBe(true);
      expect(validateWarpTransform(transform)).toMatchObject({ valid: true });
      const evaluator = createWarpEvaluator(transform);
      expect(evaluator.map({ x: 0.37, y: 0.62 })).toEqual(
        expect.objectContaining({
          x: expect.closeTo(0.37, 8),
          y: expect.closeTo(0.62, 8),
        }),
      );
    },
  );

  it.each(WARP_PRESET_NAMES)("keeps the %s preset safe", (name) => {
    const transform = createWarpPreset(name, 5);
    expect(isIdentityWarpTransform(transform)).toBe(false);
    expect(validateWarpTransform(transform)).toMatchObject({ valid: true });
  });

  it("maps every deformed anchor back to its source anchor", () => {
    const transform = createWarpPreset("wave", 5);
    const identity = createIdentityWarpPoints(5);
    const inverse = createInverseWarpEvaluator(transform);
    transform.points.forEach((point, index) => {
      expect(inverse.map(point).x).toBeCloseTo(identity[index].x, 7);
      expect(inverse.map(point).y).toBeCloseTo(identity[index].y, 7);
    });
  });

  it("resamples a smooth 3x3-cell warp onto a 5x5-cell lattice", () => {
    const source = createWarpPreset("archUp", 3);
    const evaluator = createWarpEvaluator(source);
    const resampled = resampleWarpTransform(source, 5);
    expect(resampled.gridSize).toBe(5);
    expect(resampled.points).toHaveLength(36);
    expect(isValidWarpTransform(resampled)).toBe(true);
    const center = { x: 0.4, y: 0.6 };
    const expected = evaluator.map(center);
    const actual = createWarpEvaluator(resampled).map(center);
    expect(actual.x).toBeCloseTo(expected.x, 5);
    expect(actual.y).toBeCloseTo(expected.y, 5);
  });

  it("resets only selected anchors to their identity positions", () => {
    const source = createWarpPreset("wave", 3);
    const reset = resetWarpPointIndexes(source, [1, 6]);
    const identity = createIdentityWarpPoints(3);
    expect(reset.points[1]).toEqual(identity[1]);
    expect(reset.points[6]).toEqual(identity[6]);
    expect(reset.points[2]).toEqual(source.points[2]);
  });

  it("rejects wrong counts, non-finite points, and folded meshes", () => {
    const wrongVersion = createIdentityWarpTransform(3);
    (wrongVersion as { version: number }).version = 2;
    expect(validateWarpTransform(wrongVersion).reason).toBe("wrong-version");

    const wrongCount = createIdentityWarpTransform(3);
    wrongCount.points.pop();
    expect(validateWarpTransform(wrongCount).reason).toBe("wrong-point-count");

    const nonFinite = createIdentityWarpTransform(3);
    nonFinite.points[2] = { x: Number.NaN, y: 0 };
    expect(validateWarpTransform(nonFinite).reason).toBe("non-finite");

    const folded = createIdentityWarpTransform(3);
    [folded.points[5], folded.points[6]] = [folded.points[6], folded.points[5]];
    expect(isValidWarpTransform(folded)).toBe(false);
    expect(["folded", "compressed"]).toContain(
      validateWarpTransform(folded).reason,
    );
  });

  it("accepts safe persisted warps and rejects malformed ones", () => {
    const block = makeBlock({ warpTransform: createWarpPreset("bulge", 3) });
    expect(TranslationBlockSchema.parse(block).warpTransform?.gridSize).toBe(3);
    expect(() =>
      TranslationBlockSchema.parse({
        ...block,
        warpTransform: {
          version: 1,
          gridSize: 5,
          points: createIdentityWarpPoints(3),
        },
      }),
    ).toThrow();
  });
});

describe("warp displacement maps", () => {
  it("uses a bounded preview map and a larger committed map", () => {
    expect(
      resolveWarpMapRasterSize({ width: 900, height: 300, preview: true }),
    ).toEqual({ width: 112, height: 37 });
    expect(
      resolveWarpMapRasterSize({ width: 900, height: 300, preview: false }),
    ).toEqual({ width: 512, height: 171 });
  });

  it.each(WARP_PRESET_NAMES)("encodes a finite inverse map for %s", (name) => {
    const map = createWarpDisplacementPixels(createWarpPreset(name, 3), 40, 24);
    expect(map.pixels).toHaveLength(40 * 24 * 4);
    expect(map.scale).toBeGreaterThan(0);
    expect(map.bounds.width).toBeGreaterThan(1);
    expect(map.bounds.height).toBeGreaterThan(1);
    for (let offset = 0; offset < map.pixels.length; offset += 4) {
      expect(map.pixels[offset]).toBeGreaterThanOrEqual(0);
      expect(map.pixels[offset]).toBeLessThanOrEqual(255);
      expect(map.pixels[offset + 1]).toBeGreaterThanOrEqual(0);
      expect(map.pixels[offset + 1]).toBeLessThanOrEqual(255);
      expect(map.pixels[offset + 3]).toBe(255);
    }
  });

  it("encodes displacement in the warped block's pixel coordinate space", () => {
    const transform = createWarpPreset("flag", 5);
    const short = createWarpDisplacementPixels(transform, 48, 32, {
      width: 600,
      height: 200,
    });
    const tall = createWarpDisplacementPixels(transform, 48, 32, {
      width: 600,
      height: 600,
    });
    expect(tall.scale).toBeGreaterThan(short.scale * 2.8);
    expect(tall.scale).toBeLessThan(short.scale * 3.2);
  });
});

function makeBlock(patch: Partial<TranslationBlock> = {}): TranslationBlock {
  return {
    id: "warp-block",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 400, h: 200 },
    sourceText: "원문",
    translatedText: "번역",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 32,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    ...patch,
  };
}
