import {
  isUsableBubbleLayout,
  type BubbleLayout,
  type BubbleShapeRegion,
} from "./bubbleLayout";
import { resolveDisjointBubbleLayout } from "./bubbleLayoutDisjoint";
import {
  BUBBLE_SLOT_COORDINATE_EPSILON,
  combineBubbleRegionPlanPrefixes,
  intersectBubbleRegionLineBand,
} from "./bubbleShapeSlotPrimitives";

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
const COORDINATE_EPSILON = BUBBLE_SLOT_COORDINATE_EPSILON;

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
    const interval = intersectBubbleRegionLineBand(
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

function combineRegionPlans(
  regionPlans: NaturalShapeLineSlot[][][],
  maximumSlotCount: number,
): NaturalShapeLineSlot[][] {
  return combineBubbleRegionPlanPrefixes(
    regionPlans,
    maximumSlotCount,
    MAX_PLANS_PER_SLOT_COUNT,
  );
}

function clampCoordinate(value: number): number {
  if (Math.abs(value) <= COORDINATE_EPSILON) return 0;
  if (Math.abs(1 - value) <= COORDINATE_EPSILON) return 1;
  return Math.max(0, Math.min(1, value));
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
