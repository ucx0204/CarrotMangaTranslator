import { expect, it } from "vitest";
import type { ImageRedactionStroke } from "../src/shared/imageRedaction";
import {
  rasterizeImageRedaction,
  rasterizeImageRedactionRegion,
} from "../src/shared/imageRedactionRaster";

it("matches full native masks across fractional brushes, nested copies and global erasers", () => {
  const strokes: ImageRedactionStroke[] = [
    {
      shape: "rectangle",
      size: 1,
      points: [
        { x: 3.1, y: 4.2 },
        { x: 20, y: 23 },
      ],
    },
    {
      shape: "round",
      size: 6.5,
      operation: "restore",
      points: [{ x: 12.5, y: 12.5 }],
    },
    {
      shape: "square",
      size: 8,
      isolation: [1],
      points: [
        { x: 7, y: 8 },
        { x: 18, y: 19 },
      ],
    },
    {
      shape: "round",
      size: 9,
      operation: "restore",
      isolation: [1],
      points: [{ x: 10, y: 10 }],
    },
    { shape: "round", size: 2, isolation: [1, 2], points: [{ x: 10, y: 10 }] },
    {
      shape: "rectangle",
      size: 1,
      operation: "restore",
      points: [
        { x: 16, y: 0 },
        { x: 19, y: 32 },
      ],
    },
  ];
  const full = rasterizeImageRedaction(32, 32, strokes);
  for (const x of [0, 5, 14, 25])
    for (const y of [0, 5, 14, 25]) {
      const tile = rasterizeImageRedactionRegion(32, 32, strokes, {
        x,
        y,
        width: 7,
        height: 7,
      });
      const expected = Uint8Array.from(
        Array.from(
          { length: 49 },
          (_, index) =>
            full[(y + Math.floor(index / 7)) * 32 + x + (index % 7)],
        ),
      );
      expect(tile).toEqual(expected);
    }
});

it("allocates only the requested tile even for a source at the maximum pixel budget", () => {
  const tile = rasterizeImageRedactionRegion(100000, 1200, [], {
    x: 99990,
    y: 1190,
    width: 10,
    height: 10,
  });
  expect(tile.byteLength).toBe(100);
});

it.each([
  { x: -1, y: 0, width: 1, height: 1 },
  { x: 0.5, y: 0, width: 1, height: 1 },
  { x: 0, y: 0, width: 513, height: 1 },
  { x: 1000, y: 0, width: 1, height: 1 },
])("rejects invalid or unbounded tile requests (%j)", (region) => {
  expect(() => rasterizeImageRedactionRegion(1000, 1000, [], region)).toThrow();
});
