import { expect, it } from "vitest";
import {
  moveBbox,
  resizeBbox,
  RESIZE_DIRECTIONS,
} from "../src/shared/regionSelectionGeometry";
const box = { x: 100, y: 200, w: 300, h: 400 };
it("keeps moved selections inside the crop with dimensions unchanged", () => {
  expect(moveBbox(box, -1000, 1000)).toEqual({ x: 0, y: 600, w: 300, h: 400 });
  expect(moveBbox(box, 25, -30)).toEqual({ x: 125, y: 170, w: 300, h: 400 });
});
it("retains the established SFX resize behavior for all handles and minimum sizes", () => {
  const expected = [
    { x: 110, y: 220, w: 290, h: 380 },
    { x: 100, y: 220, w: 300, h: 380 },
    { x: 100, y: 220, w: 310, h: 380 },
    { x: 100, y: 200, w: 310, h: 400 },
    { x: 100, y: 200, w: 310, h: 420 },
    { x: 100, y: 200, w: 300, h: 420 },
    { x: 110, y: 200, w: 290, h: 420 },
    { x: 110, y: 200, w: 290, h: 400 },
  ];
  RESIZE_DIRECTIONS.forEach((direction, i) =>
    expect(resizeBbox(box, direction, 10, 20)).toEqual(expected[i]),
  );
  expect(resizeBbox(box, "nw", 1000, 1000)).toEqual({
    x: 398,
    y: 598,
    w: 2,
    h: 2,
  });
  expect(resizeBbox(box, "se", -1000, -1000)).toEqual({
    x: 100,
    y: 200,
    w: 2,
    h: 2,
  });
  expect(resizeBbox(box, "se", 1000, 1000)).toEqual({
    x: 100,
    y: 200,
    w: 900,
    h: 800,
  });
});

it("keeps every handle inside the image for already-small boxes at all four edges", () => {
  for (const [x, y] of [
    [0, 0],
    [0, 999],
    [999, 0],
    [999, 999],
  ])
    for (const direction of RESIZE_DIRECTIONS)
      for (const delta of [0, -1, 1, -1000, 1000]) {
        const original = { x, y, w: 1, h: 1 };
        const result = resizeBbox(original, direction, delta, delta);
        expect(result.x).toBeGreaterThanOrEqual(0);
        expect(result.y).toBeGreaterThanOrEqual(0);
        expect(result.x + result.w).toBeLessThanOrEqual(1000);
        expect(result.y + result.h).toBeLessThanOrEqual(1000);
        expect(result.w).toBeGreaterThanOrEqual(1);
        expect(result.h).toBeGreaterThanOrEqual(1);
        if (delta === 0) expect(result).toEqual(original);
      }
});
