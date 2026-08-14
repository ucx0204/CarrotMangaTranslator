import type { BubbleShapeRegion } from "./bubbleLayout";

export const BUBBLE_SLOT_COORDINATE_EPSILON = 1e-7;

export type BubbleInlineInterval = {
  inlineStart: number;
  inlineEnd: number;
};

export function intersectBubbleRegionLineBand(
  region: BubbleShapeRegion,
  blockStart: number,
  blockEnd: number,
): BubbleInlineInterval | null {
  if (!isValidLineBand(blockStart, blockEnd)) return null;

  let cursor = blockStart;
  let inlineStart = 0;
  let inlineEnd = 1;
  let touched = false;
  for (const span of region.spans) {
    if (span.blockEnd <= cursor + BUBBLE_SLOT_COORDINATE_EPSILON) continue;
    if (span.blockStart >= blockEnd - BUBBLE_SLOT_COORDINATE_EPSILON) break;
    if (span.blockStart > cursor + BUBBLE_SLOT_COORDINATE_EPSILON) return null;

    const coveredEnd = Math.min(blockEnd, span.blockEnd);
    if (coveredEnd <= cursor + BUBBLE_SLOT_COORDINATE_EPSILON) continue;
    touched = true;
    inlineStart = Math.max(inlineStart, span.inlineStart);
    inlineEnd = Math.min(inlineEnd, span.inlineEnd);
    if (inlineEnd <= inlineStart + BUBBLE_SLOT_COORDINATE_EPSILON) return null;
    cursor = coveredEnd;
    if (cursor >= blockEnd - BUBBLE_SLOT_COORDINATE_EPSILON) {
      return { inlineStart, inlineEnd };
    }
  }
  return touched && cursor >= blockEnd - BUBBLE_SLOT_COORDINATE_EPSILON
    ? { inlineStart, inlineEnd }
    : null;
}

export function combineBubbleRegionPlanPrefixes<T>(
  regionPlans: T[][][],
  maximumSlotCount: number,
  maximumPlansPerSlotCount: number,
): T[][] {
  const usableRegionPlans: T[][][] = [];
  for (const candidates of regionPlans) {
    if (candidates.length === 0) break;
    usableRegionPlans.push(candidates);
  }
  if (usableRegionPlans.length === 0) return [];

  const plans: T[][] = [];
  for (let slotCount = 1; slotCount <= maximumSlotCount; slotCount += 1) {
    const maximumCoveredRegions = Math.min(usableRegionPlans.length, slotCount);
    for (
      let coveredRegions = maximumCoveredRegions;
      coveredRegions >= 1;
      coveredRegions -= 1
    ) {
      plans.push(
        ...combinePrefixAtSlotCount(
          usableRegionPlans.slice(0, coveredRegions),
          slotCount,
          maximumPlansPerSlotCount,
        ),
      );
    }
  }
  return plans;
}

function combinePrefixAtSlotCount<T>(
  regionPlans: T[][][],
  slotCount: number,
  maximumPlansPerSlotCount: number,
): T[][] {
  const combined: T[][] = [];
  const selected: T[][] = [];
  const targetLineCount = slotCount / regionPlans.length;

  const visit = (regionIndex: number, remaining: number): void => {
    if (combined.length >= maximumPlansPerSlotCount) return;
    if (regionIndex === regionPlans.length) {
      if (remaining === 0) combined.push(selected.flat());
      return;
    }

    const remainingRegions = regionPlans.length - regionIndex - 1;
    const orderedCandidates = [...(regionPlans[regionIndex] ?? [])]
      .filter(
        (candidate) =>
          candidate.length <= remaining - remainingRegions &&
          candidate.length >= 1,
      )
      .sort(
        (left, right) =>
          Math.abs(left.length - targetLineCount) -
            Math.abs(right.length - targetLineCount) ||
          right.length - left.length,
      );
    for (const candidate of orderedCandidates) {
      selected.push(candidate);
      visit(regionIndex + 1, remaining - candidate.length);
      selected.pop();
      if (combined.length >= maximumPlansPerSlotCount) break;
    }
  };

  visit(0, slotCount);
  return combined;
}

function isValidLineBand(blockStart: number, blockEnd: number): boolean {
  return (
    Number.isFinite(blockStart) &&
    Number.isFinite(blockEnd) &&
    blockStart >= 0 &&
    blockEnd <= 1 &&
    blockStart < blockEnd
  );
}
