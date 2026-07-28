import { describe, expect, it } from "vitest";
import { partitionSameBlockBubbleRegions } from "../src/main/bubbleLayout/bubbleSameBlockRegionPartition";
import type { RefinedBubbleRegion } from "../src/main/bubbleLayout/bubbleMaskTypes";

describe("same-block bubble region partition", () => {
  it("separates diagonally overlapping connected lobes without changing their order", () => {
    const lowerLeft = ellipticalRegion(5, 20, 36, 46);
    const upperRight = ellipticalRegion(27, 4, 40, 44);

    const result = partitionSameBlockBubbleRegions([lowerLeft, upperRight], 4);

    expect(result).toHaveLength(2);
    expect(centerOf(result[0]).x).toBeLessThan(centerOf(result[1]).x);
    expect(
      minimumMaskEdgeDistance(result[0], result[1]),
    ).toBeGreaterThanOrEqual(4);
    expect(maskIntersectionCount(result[0], result[1])).toBe(0);
  });

  it("creates a horizontal gutter between side-by-side regions", () => {
    const left = rectangularRegion(0, 4, 30, 24);
    const right = rectangularRegion(20, 4, 30, 24);

    const result = partitionSameBlockBubbleRegions([left, right], 5);

    expect(result).toHaveLength(2);
    expect(
      result[1].bounds.x - (result[0].bounds.x + result[0].bounds.w),
    ).toBeGreaterThanOrEqual(5);
    expect(
      minimumMaskEdgeDistance(result[0], result[1]),
    ).toBeGreaterThanOrEqual(5);
  });

  it("creates a vertical gutter between stacked regions", () => {
    const top = rectangularRegion(4, 0, 24, 30);
    const bottom = rectangularRegion(4, 20, 24, 30);

    const result = partitionSameBlockBubbleRegions([top, bottom], 3);

    expect(result).toHaveLength(2);
    expect(
      result[1].bounds.y - (result[0].bounds.y + result[0].bounds.h),
    ).toBeGreaterThanOrEqual(3);
    expect(
      minimumMaskEdgeDistance(result[0], result[1]),
    ).toBeGreaterThanOrEqual(3);
  });

  it("leaves single and already separated regions byte-for-byte untouched", () => {
    const single = rectangularRegion(10, 10, 20, 20);
    expect(partitionSameBlockBubbleRegions([single], 4)[0]).toBe(single);

    const left = rectangularRegion(0, 0, 12, 12);
    const right = rectangularRegion(17, 0, 12, 12);
    const result = partitionSameBlockBubbleRegions([left, right], 4);
    expect(result[0]).toBe(left);
    expect(result[1]).toBe(right);
  });

  it("keeps three overlapping reading-order regions pairwise disjoint", () => {
    const regions = [
      rectangularRegion(0, 0, 26, 30),
      rectangularRegion(18, 0, 26, 30),
      rectangularRegion(36, 0, 26, 30),
    ];

    const result = partitionSameBlockBubbleRegions(regions, 3);

    expect(result).toHaveLength(3);
    for (let left = 0; left < result.length; left += 1) {
      for (let right = left + 1; right < result.length; right += 1) {
        expect(maskIntersectionCount(result[left], result[right])).toBe(0);
        expect(
          minimumMaskEdgeDistance(result[left], result[right]),
        ).toBeGreaterThanOrEqual(3);
      }
    }
    expect(result.map((region) => centerOf(region).x)).toEqual(
      [...result.map((region) => centerOf(region).x)].sort(
        (left, right) => left - right,
      ),
    );
  });

  it("drops an impossible later duplicate instead of restoring overlap", () => {
    const first = rectangularRegion(0, 0, 4, 12);
    const duplicate = rectangularRegion(0, 0, 4, 12);

    const result = partitionSameBlockBubbleRegions([first, duplicate], 4);

    expect(result).toEqual([first]);
  });
});

function rectangularRegion(
  x: number,
  y: number,
  width: number,
  height: number,
): RefinedBubbleRegion {
  return {
    bounds: { x, y, w: width, h: height },
    width,
    height,
    area: width * height,
    mask: new Uint8Array(width * height).fill(1),
  };
}

function ellipticalRegion(
  x: number,
  y: number,
  width: number,
  height: number,
): RefinedBubbleRegion {
  const mask = new Uint8Array(width * height);
  let area = 0;
  for (let localY = 0; localY < height; localY += 1) {
    for (let localX = 0; localX < width; localX += 1) {
      const normalizedX = (localX + 0.5 - width / 2) / (width / 2);
      const normalizedY = (localY + 0.5 - height / 2) / (height / 2);
      if (normalizedX ** 2 + normalizedY ** 2 > 1) continue;
      mask[localY * width + localX] = 1;
      area += 1;
    }
  }
  return { bounds: { x, y, w: width, h: height }, width, height, area, mask };
}

function maskIntersectionCount(
  left: RefinedBubbleRegion,
  right: RefinedBubbleRegion,
): number {
  const leftPixels = new Set(activePixels(left).map(({ x, y }) => `${x}:${y}`));
  return activePixels(right).filter(({ x, y }) => leftPixels.has(`${x}:${y}`))
    .length;
}

function minimumMaskEdgeDistance(
  left: RefinedBubbleRegion,
  right: RefinedBubbleRegion,
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const leftPixel of activePixels(left)) {
    for (const rightPixel of activePixels(right)) {
      minimum = Math.min(
        minimum,
        Math.hypot(
          Math.max(0, Math.abs(leftPixel.x - rightPixel.x) - 1),
          Math.max(0, Math.abs(leftPixel.y - rightPixel.y) - 1),
        ),
      );
    }
  }
  return minimum;
}

function activePixels(region: RefinedBubbleRegion): { x: number; y: number }[] {
  const pixels: { x: number; y: number }[] = [];
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      if (!region.mask[y * region.width + x]) continue;
      pixels.push({ x: region.bounds.x + x, y: region.bounds.y + y });
    }
  }
  return pixels;
}

function centerOf(region: RefinedBubbleRegion): { x: number; y: number } {
  return {
    x: region.bounds.x + region.bounds.w / 2,
    y: region.bounds.y + region.bounds.h / 2,
  };
}
