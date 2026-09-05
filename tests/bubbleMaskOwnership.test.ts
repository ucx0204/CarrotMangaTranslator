import { assert, describe, expect, it } from "vitest";
import {
  createBubbleMaskOwnershipResolver,
  isMaskOwnedPoint,
} from "../src/main/bubbleLayout/bubbleMaskOwnership";
import {
  distanceFromMaskBoundary,
  erodeBinaryMask,
} from "../src/main/bubbleLayout/bubbleDistanceTransform";

describe("shared detector-mask ownership", () => {
  it("keeps each lobe with its source and shares a disjoint field for every owner", () => {
    const width = 64,
      height = 48;
    const logits = new Float32Array(width * height).fill(-1);
    for (let y = 2; y < 46; y++)
      for (let x = 2; x < 62; x++) {
        if (x < 35 || (x >= 45 && y > 10 && y < 36) || (y >= 22 && y <= 25))
          logits[y * width + x] = 1;
      }
    const mask = { width, height, logits };
    const left = { x: 22, y: 18, w: 10, h: 12 };
    const right = { x: 48, y: 16, w: 10, h: 14 };
    const resolve = createBubbleMaskOwnershipResolver(width, height);
    const a = resolve(mask, left, [right]);
    const b = resolve(mask, right, [left]);
    assert(a);
    assert(b);
    expect(a.distances).toBe(b.distances);
    expect(isMaskOwnedPoint(a, 32, 5, 2)).toBe(true);
    expect(isMaskOwnedPoint(b, 49, 33, 2)).toBe(true);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        expect(
          isMaskOwnedPoint(a, x, y, 2) === true &&
            isMaskOwnedPoint(b, x, y, 2) === true,
        ).toBe(false);
      }
    expect(resolve(mask, { x: 36, y: 0, w: 4, h: 4 }, [left])).toBeUndefined();
  });

  it("retains the existing chamfer erosion contract", () => {
    const mask = new Uint8Array(81).fill(1);
    const distances = distanceFromMaskBoundary(mask, 9, 9);
    expect(distances[4 * 9 + 4]).toBe(4);
    expect(distances[0]).toBe(0);
    expect(
      Array.from(erodeBinaryMask(mask, 9, 9, 2)).reduce(
        (sum, value) => sum + value,
        0,
      ),
    ).toBe(9);
  });
});
