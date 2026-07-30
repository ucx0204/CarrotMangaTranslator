import { describe, expect, it } from "vitest";
import type { BlockBubbleCandidate } from "../src/main/bubbleLayout/bubbleBlockAssociation";
import { partitionSharedBubbleOwnership } from "../src/main/bubbleLayout/bubbleOwnershipPartition";
import {
  buildOwnershipFallbackRegion,
  clipRegionsToOwnershipPartition,
} from "../src/main/bubbleLayout/bubbleRegionPartition";
import type { ComicPageDetection } from "../src/main/bubbleLayout/contracts";
import type { RefinedBubbleRegion } from "../src/main/bubbleLayout/bubbleMaskTypes";
import type { BBox } from "../src/shared/textTypes";

describe("bubble ownership region partition", () => {
  it("uses OCR proximity instead of a full-height straight cut for diagonal owners", () => {
    const bubbleBox = { x: 0, y: 0, w: 100, h: 100 };
    const upperRight = {
      id: "upper-right",
      bbox: { x: 60, y: 10, w: 20, h: 30 },
    };
    const lowerLeft = {
      id: "lower-left",
      bbox: { x: 20, y: 60, w: 20, h: 30 },
    };
    const sharedDetection = bubbleDetection(bubbleBox);
    const ownerships = partitionSharedBubbleOwnership(
      [upperRight, lowerLeft].map((owner) => ({
        owner,
        candidates: [candidate(bubbleBox, sharedDetection)],
      })),
      (owner) => owner.bbox,
      4,
    );
    const upperRegion = buildOwnershipFallbackRegion(
      ownerships[0].candidates[0],
      0,
    );
    const lowerRegion = buildOwnershipFallbackRegion(
      ownerships[1].candidates[0],
      0,
    );

    expect(upperRegion).not.toBeNull();
    expect(lowerRegion).not.toBeNull();
    // These points sit on the "wrong" side of the legacy vertical cut, but
    // are close to the diagonally placed owner and should use that free space.
    expect(readPageMask(upperRegion, 45, 20)).toBe(1);
    expect(readPageMask(lowerRegion, 45, 20)).toBe(0);
    expect(readPageMask(upperRegion, 55, 80)).toBe(0);
    expect(readPageMask(lowerRegion, 55, 80)).toBe(1);
    expect(readPageMask(upperRegion, 50, 50)).toBe(0);
    expect(readPageMask(lowerRegion, 50, 50)).toBe(0);
    expectRegionsDisjoint(upperRegion, lowerRegion, bubbleBox);
  });

  it("keeps zero-gap ownership disjoint and marks one shared crop group", () => {
    const bubbleBox = { x: 10, y: 10, w: 100, h: 60 };
    const left = { id: "left", bbox: { x: 20, y: 25, w: 25, h: 30 } };
    const right = { id: "right", bbox: { x: 75, y: 25, w: 25, h: 30 } };
    const sharedDetection = bubbleDetection(bubbleBox);
    const ownerships = partitionSharedBubbleOwnership(
      [left, right].map((owner) => ({
        owner,
        candidates: [candidate(bubbleBox, sharedDetection)],
      })),
      (owner) => owner.bbox,
      0,
    );
    const leftPartition = ownerships[0].candidates[0].ownershipPartition;
    const rightPartition = ownerships[1].candidates[0].ownershipPartition;
    const leftRegion = buildOwnershipFallbackRegion(
      ownerships[0].candidates[0],
      0,
    );
    const rightRegion = buildOwnershipFallbackRegion(
      ownerships[1].candidates[0],
      0,
    );

    expect(leftPartition?.sharedGroupId).toBe(rightPartition?.sharedGroupId);
    expect(leftPartition?.gapPx).toBe(0);
    expect(rightPartition?.gapPx).toBe(0);
    expect(
      (leftPartition?.clipBox.x ?? 0) + (leftPartition?.clipBox.w ?? 0),
    ).toBe(rightPartition?.clipBox.x);
    expectRegionsDisjoint(leftRegion, rightRegion, bubbleBox);
  });

  it("keeps fallback regions rounded while preserving a gap between owners", () => {
    const bubbleBox = { x: 10, y: 10, w: 100, h: 60 };
    const left = { id: "left", bbox: { x: 20, y: 25, w: 25, h: 30 } };
    const right = { id: "right", bbox: { x: 75, y: 25, w: 25, h: 30 } };
    const sharedDetection = bubbleDetection(bubbleBox);
    const ownerships = partitionSharedBubbleOwnership(
      [left, right].map((owner) => ({
        owner,
        candidates: [candidate(bubbleBox, sharedDetection)],
      })),
      (owner) => owner.bbox,
      4,
    );
    const leftRegion = buildOwnershipFallbackRegion(
      ownerships[0].candidates[0],
      0,
    );
    const rightRegion = buildOwnershipFallbackRegion(
      ownerships[1].candidates[0],
      0,
    );

    expect(readPageMask(leftRegion, 10, 10)).toBe(0);
    expect(readPageMask(rightRegion, 109, 10)).toBe(0);
    expect(readPageMask(leftRegion, 58, 40)).toBe(0);
    expect(readPageMask(rightRegion, 61, 40)).toBe(0);
    expect(readPageMask(leftRegion, 40, 40)).toBe(1);
    expect(readPageMask(rightRegion, 80, 40)).toBe(1);
    expectRegionsDisjoint(leftRegion, rightRegion, bubbleBox);
  });

  it("applies the same proximity ownership to refined detector masks", () => {
    const bubbleBox = { x: 0, y: 0, w: 80, h: 80 };
    const upperRight = {
      id: "upper-right",
      bbox: { x: 48, y: 8, w: 20, h: 24 },
    };
    const lowerLeft = {
      id: "lower-left",
      bbox: { x: 12, y: 48, w: 20, h: 24 },
    };
    const sharedDetection = bubbleDetection(bubbleBox);
    const ownerships = partitionSharedBubbleOwnership(
      [upperRight, lowerLeft].map((owner) => ({
        owner,
        candidates: [candidate(bubbleBox, sharedDetection)],
      })),
      (owner) => owner.bbox,
      3,
    );
    const fullMask: RefinedBubbleRegion = {
      bounds: bubbleBox,
      width: 80,
      height: 80,
      area: 80 * 80,
      mask: new Uint8Array(80 * 80).fill(1),
    };
    const upperRegion = clipRegionsToOwnershipPartition(
      [fullMask],
      ownerships[0].candidates[0].ownershipPartition,
    )[0];
    const lowerRegion = clipRegionsToOwnershipPartition(
      [fullMask],
      ownerships[1].candidates[0].ownershipPartition,
    )[0];

    expect(readPageMask(upperRegion, 35, 12)).toBe(1);
    expect(readPageMask(lowerRegion, 35, 12)).toBe(0);
    expect(readPageMask(upperRegion, 45, 68)).toBe(0);
    expect(readPageMask(lowerRegion, 45, 68)).toBe(1);
    expectRegionsDisjoint(upperRegion, lowerRegion, bubbleBox);
  });
});

function candidate(
  bubbleBox: BBox,
  detection = bubbleDetection(bubbleBox),
): BlockBubbleCandidate {
  return {
    bubbleDetection: detection,
    bubbleBox,
    promptBoxes: [],
    score: 0.9,
  };
}

function bubbleDetection(bubbleBox: BBox): ComicPageDetection {
  return {
    labelId: 0,
    label: "bubble",
    box: [
      bubbleBox.x,
      bubbleBox.y,
      bubbleBox.x + bubbleBox.w,
      bubbleBox.y + bubbleBox.h,
    ],
    score: 0.95,
  };
}

function readPageMask(
  region: RefinedBubbleRegion | null | undefined,
  pageX: number,
  pageY: number,
): number {
  if (!region) return 0;
  const x = pageX - region.bounds.x;
  const y = pageY - region.bounds.y;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= region.width ||
    y >= region.height
  ) {
    return 0;
  }
  return region.mask[y * region.width + x] ?? 0;
}

function expectRegionsDisjoint(
  left: RefinedBubbleRegion | null,
  right: RefinedBubbleRegion | null,
  bounds: BBox,
): void {
  for (let y = bounds.y; y < bounds.y + bounds.h; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.w; x += 1) {
      expect(readPageMask(left, x, y) + readPageMask(right, x, y)).toBeLessThan(
        2,
      );
    }
  }
}
