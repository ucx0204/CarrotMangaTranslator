import {
  isUsableBubbleLayout,
  type BubbleLayout,
  type BubbleShapeRegion,
} from "./bubbleLayout";
import { resolveDisjointBubbleLayout } from "./bubbleLayoutDisjoint";

export type NaturalShapeLineSlot = {
  availableWidthPx: number;
  regionIndex: number;
};

export type NaturalShapeSlotPlan = {
  slots: NaturalShapeLineSlot[];
};

export type NaturalShapeSlotPlanInput = {
  blockExtentPx: number;
  inlineExtentPx: number;
  fontSizePx: number;
  fontWidthScale: number;
  lineHeight: number;
  maximumSlotCount: number;
};

const MIN_BUBBLE_LAYOUT_CONFIDENCE = 0.5;
const MAX_NATURAL_SHAPE_LINES = 12;
const MAX_PLANS_PER_SLOT_COUNT = 2;
const INLINE_SAFETY_RATIO = 0.97;
const COORDINATE_EPSILON = 1e-7;

/**
 * Produces the same kind of complete-line-band slots consumed by the renderer,
 * but keeps the representation measurement-library agnostic. A curved edge is
 * therefore respected across the full height of a line, rather than sampled
 * at only its baseline or centre.
 */
export function resolveNaturalShapeSlotPlans(
  value: unknown,
  input: NaturalShapeSlotPlanInput,
): NaturalShapeSlotPlan[] {
  if (!isEligibleHorizontalBubbleLayout(value, input)) return [];
  const maximumSlotCount = Math.max(
    1,
    Math.min(MAX_NATURAL_SHAPE_LINES, Math.floor(input.maximumSlotCount)),
  );
  const lineHeightPx = input.fontSizePx * Math.max(1, input.lineHeight || 1.18);
  const layout =
    resolveDisjointBubbleLayout(value, {
      blockExtentPx: input.blockExtentPx,
      inlineExtentPx: input.inlineExtentPx,
    }) ?? value;
  const regionPlans = layout.regions.map((region, regionIndex) =>
    resolveRegionPlans(
      region,
      regionIndex,
      input,
      lineHeightPx,
      maximumSlotCount,
    ),
  );
  return combineRegionPlans(regionPlans, maximumSlotCount).map((slots) => ({
    slots,
  }));
}

function isEligibleHorizontalBubbleLayout(
  value: unknown,
  input: NaturalShapeSlotPlanInput,
): value is BubbleLayout {
  return (
    isUsableBubbleLayout(value) &&
    value.direction === "horizontal" &&
    value.confidence >= MIN_BUBBLE_LAYOUT_CONFIDENCE &&
    isPositiveFinite(input.blockExtentPx) &&
    isPositiveFinite(input.inlineExtentPx) &&
    isPositiveFinite(input.fontSizePx) &&
    isPositiveFinite(input.fontWidthScale) &&
    isPositiveFinite(input.lineHeight) &&
    Number.isFinite(input.maximumSlotCount) &&
    input.maximumSlotCount >= 1
  );
}

function resolveRegionPlans(
  region: BubbleShapeRegion,
  regionIndex: number,
  input: NaturalShapeSlotPlanInput,
  lineHeightPx: number,
  maximumSlotCount: number,
): NaturalShapeLineSlot[][] {
  const first = region.spans[0];
  const last = region.spans.at(-1);
  if (!first || !last) return [];

  const regionStartPx = first.blockStart * input.blockExtentPx;
  const regionEndPx = last.blockEnd * input.blockExtentPx;
  const regionExtentPx = Math.max(0, regionEndPx - regionStartPx);
  const maximumLineCount = Math.min(
    maximumSlotCount,
    Math.floor((regionExtentPx + COORDINATE_EPSILON) / lineHeightPx),
  );
  const plans: NaturalShapeLineSlot[][] = [];
  for (let lineCount = 1; lineCount <= maximumLineCount; lineCount += 1) {
    const plan = resolveCenteredRegionPlan(
      region,
      regionIndex,
      lineCount,
      regionStartPx,
      regionEndPx,
      input,
      lineHeightPx,
    );
    if (plan) plans.push(plan);
  }
  return plans;
}

function resolveCenteredRegionPlan(
  region: BubbleShapeRegion,
  regionIndex: number,
  lineCount: number,
  regionStartPx: number,
  regionEndPx: number,
  input: NaturalShapeSlotPlanInput,
  lineHeightPx: number,
): NaturalShapeLineSlot[] | null {
  const contentExtentPx = lineCount * lineHeightPx;
  const blockOffsetPx = (regionStartPx + regionEndPx - contentExtentPx) / 2;
  if (
    blockOffsetPx < regionStartPx - COORDINATE_EPSILON ||
    blockOffsetPx + contentExtentPx > regionEndPx + COORDINATE_EPSILON
  ) {
    return null;
  }

  const slots: NaturalShapeLineSlot[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    const lineStartPx = blockOffsetPx + index * lineHeightPx;
    const lineEndPx = lineStartPx + lineHeightPx;
    const interval = intersectRegionLineBand(
      region,
      clampCoordinate(lineStartPx / input.blockExtentPx),
      clampCoordinate(lineEndPx / input.blockExtentPx),
    );
    if (!interval) return null;
    const availableWidthPx =
      ((interval.inlineEnd - interval.inlineStart) *
        input.inlineExtentPx *
        INLINE_SAFETY_RATIO) /
      input.fontWidthScale;
    if (!isPositiveFinite(availableWidthPx)) return null;
    slots.push({ availableWidthPx, regionIndex });
  }
  return slots;
}

function intersectRegionLineBand(
  region: BubbleShapeRegion,
  blockStart: number,
  blockEnd: number,
): { inlineStart: number; inlineEnd: number } | null {
  if (!isValidLineBand(blockStart, blockEnd)) return null;

  let cursor = blockStart;
  let inlineStart = 0;
  let inlineEnd = 1;
  let touched = false;
  for (const span of region.spans) {
    if (span.blockEnd <= cursor + COORDINATE_EPSILON) continue;
    if (span.blockStart >= blockEnd - COORDINATE_EPSILON) break;
    if (span.blockStart > cursor + COORDINATE_EPSILON) return null;

    const coveredEnd = Math.min(blockEnd, span.blockEnd);
    if (coveredEnd <= cursor + COORDINATE_EPSILON) continue;
    touched = true;
    inlineStart = Math.max(inlineStart, span.inlineStart);
    inlineEnd = Math.min(inlineEnd, span.inlineEnd);
    if (inlineEnd <= inlineStart + COORDINATE_EPSILON) return null;
    cursor = coveredEnd;
    if (cursor >= blockEnd - COORDINATE_EPSILON) {
      return { inlineStart, inlineEnd };
    }
  }
  return touched && cursor >= blockEnd - COORDINATE_EPSILON
    ? { inlineStart, inlineEnd }
    : null;
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

function combineRegionPlans(
  regionPlans: NaturalShapeLineSlot[][][],
  maximumSlotCount: number,
): NaturalShapeLineSlot[][] {
  const usableRegionPlans: NaturalShapeLineSlot[][][] = [];
  for (const candidates of regionPlans) {
    if (candidates.length === 0) break;
    usableRegionPlans.push(candidates);
  }
  if (usableRegionPlans.length === 0) return [];

  const plans: NaturalShapeLineSlot[][] = [];
  for (let slotCount = 1; slotCount <= maximumSlotCount; slotCount += 1) {
    const maximumCoveredRegions = Math.min(usableRegionPlans.length, slotCount);
    for (
      let coveredRegions = maximumCoveredRegions;
      coveredRegions >= 1;
      coveredRegions -= 1
    ) {
      plans.push(
        ...combineRegionPrefixAtSlotCount(
          usableRegionPlans.slice(0, coveredRegions),
          slotCount,
        ),
      );
    }
  }
  return plans;
}

function combineRegionPrefixAtSlotCount(
  regionPlans: NaturalShapeLineSlot[][][],
  slotCount: number,
): NaturalShapeLineSlot[][] {
  const combined: NaturalShapeLineSlot[][] = [];
  const selected: NaturalShapeLineSlot[][] = [];
  const targetLineCount = slotCount / regionPlans.length;

  const visit = (regionIndex: number, remaining: number): void => {
    if (combined.length >= MAX_PLANS_PER_SLOT_COUNT) return;
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
      if (combined.length >= MAX_PLANS_PER_SLOT_COUNT) break;
    }
  };

  visit(0, slotCount);
  return combined;
}

function clampCoordinate(value: number): number {
  if (Math.abs(value) <= COORDINATE_EPSILON) return 0;
  if (Math.abs(1 - value) <= COORDINATE_EPSILON) return 1;
  return Math.max(0, Math.min(1, value));
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
