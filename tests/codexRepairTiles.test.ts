import { expect, it } from "vitest";
import {
  planCodexRepairTiles,
  prepareCodexErasureTargets,
} from "../src/main/inpainting/codexRepairTiles";
import { resolveCodexImageSize } from "../src/main/pipeline/codexImageSize";
import { expandRect } from "../src/main/inpainting/maskGeometry";

it("keeps reading hints with their own window and native crop, without promoting overlapping neighbors", () => {
  const crop = { x: 80, y: 80, w: 160, h: 160 };
  const window = { x: 100, y: 100, w: 200, h: 100 };
  const targets = [
    {
      sourceText: "complete reading",
      appearance: "fine marks on a continuous textured surface",
      bounds: { x: 120, y: 110, w: 30, h: 20 },
    },
    {
      sourceText: "overlapping neighbor",
      bounds: { x: 200, y: 150, w: 160, h: 100 },
    },
    { sourceText: "later tile", bounds: { x: 260, y: 110, w: 20, h: 20 } },
  ];
  const before = structuredClone(targets);
  expect(prepareCodexErasureTargets(targets, crop, window)).toEqual([
    { ...targets[0], bounds: { x: 40, y: 30, w: 30, h: 20 } },
  ]);
  expect(targets).toEqual(before);
  expect(prepareCodexErasureTargets(undefined, crop, window)).toBeUndefined();
  expect(prepareCodexErasureTargets([], crop, window)).toEqual([]);
  const largerReading = {
    ...targets[0],
    bounds: { x: 90, y: 90, w: 250, h: 180 },
  };
  expect(prepareCodexErasureTargets([largerReading], crop, window)).toEqual([
    { ...largerReading, bounds: { x: 10, y: 10, w: 250, h: 180 } },
  ]);
});

it.each([
  [192, 160],
  [1100, 1600],
  [2400, 1400],
])(
  "preserves the single native context on an ordinary %sx%s page",
  (width, height) => {
    const window = { x: 40, y: 60, w: 80, h: 70 };
    expect(
      planCodexRepairTiles(
        window,
        width,
        height,
        new Uint8Array(width * height).fill(1),
      ),
    ).toEqual([
      {
        cropBounds: expandRect(window, width, height, 48),
        writeBounds: expandRect(window, width, height, 48),
      },
    ]);
  },
);
it.each([
  [983, 300],
  [300, 983],
  [4000, 200],
  [200, 4000],
])(
  "plans supported, overlapping native inputs covering every selected pixel in %sx%s",
  (width, height) => {
    const window = { x: 0, y: 0, w: width, h: height };
    const mask = new Uint8Array(width * height).fill(1);
    const tiles = planCodexRepairTiles(window, width, height, mask);
    expect(tiles.length).toBeGreaterThan(1);
    const coverage = new Uint8Array(mask.length);
    const writes = new Uint8Array(mask.length);
    for (const { cropBounds: tile, writeBounds: write } of tiles) {
      expect(
        Math.max(tile.w, tile.h) / Math.min(tile.w, tile.h),
      ).toBeLessThanOrEqual(3);
      expect(tile.x + tile.w).toBeLessThanOrEqual(width);
      expect(tile.y + tile.h).toBeLessThanOrEqual(height);
      for (let y = tile.y; y < tile.y + tile.h; y++)
        for (let x = tile.x; x < tile.x + tile.w; x++)
          coverage[y * width + x]++;
      for (let y = write.y; y < write.y + write.h; y++)
        for (let x = write.x; x < write.x + write.w; x++)
          writes[y * width + x]++;
    }
    expect(coverage.every((value) => value > 0)).toBe(true);
    expect(coverage.some((value) => value > 1)).toBe(true);
    expect(writes.every((value) => value === 1)).toBe(true);
  },
);
it("does not generate tiles whose owned strip has no target", () => {
  const mask = new Uint8Array(1000 * 100);
  mask[5000] = 1;
  expect(
    planCodexRepairTiles({ x: 0, y: 0, w: 1000, h: 100 }, 1000, 100, mask),
  ).toHaveLength(1);
});
it.each([
  [1, 1],
  [121, 126],
  [555, 300],
  [1200, 800],
  [800, 2400],
  [4000, 4000],
])("requests the nearest legal size for %sx%s", (width, height) => {
  const size = resolveCodexImageSize({ width, height });
  expect(size.width % 16).toBe(0);
  expect(size.height % 16).toBe(0);
  expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(3840);
  expect(size.width * size.height).toBeGreaterThanOrEqual(655360);
  expect(size.width * size.height).toBeLessThanOrEqual(8294400);
  expect(
    Math.abs(Math.log(size.width / size.height / (width / height))),
  ).toBeLessThan(0.025);
});
it.each([
  [983, 300],
  [0, 100],
  [100, 0],
  [NaN, 100],
])(
  "rejects an unsupported request before a model call (%s,%s)",
  (width, height) => {
    expect(() => resolveCodexImageSize({ width, height })).toThrow();
  },
);
