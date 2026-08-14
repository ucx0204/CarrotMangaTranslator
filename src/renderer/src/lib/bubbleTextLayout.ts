import {
  isUsableBubbleLayout,
  type BubbleLayout,
  type BubbleShapeRegion,
} from "../../../shared/bubbleLayout";
import type { RenderTextDirection } from "../../../shared/textTypes";
import { resolveDisjointBubbleLayout } from "../../../shared/bubbleLayoutDisjoint";
import type { TextLineSlot } from "./overlayTextWrapping";
import {
  BUBBLE_SLOT_COORDINATE_EPSILON,
  combineBubbleRegionPlanPrefixes,
  intersectBubbleRegionLineBand,
} from "../../../shared/bubbleShapeSlotPrimitives";

const MAX_BUBBLE_TEXT_LINES = 128;
const MAX_PLANS_PER_SLOT_COUNT = 64;
const COORDINATE_EPSILON = BUBBLE_SLOT_COORDINATE_EPSILON;

export type BubbleSlotPlanInput = {
  /** Physical extent of the block axis (height for horizontal, width for vertical). */
  blockExtentPx: number;
  /** Physical extent of the inline axis (width for horizontal, height for vertical). */
  inlineExtentPx: number;
  fontWidthScale: number;
  /** Physical thickness of one line/column band on the block axis. */
  lineHeightPx: number;
  /** Text-derived upper bound; no plan can consume more than this many slots. */
  maximumSlotCount?: number;
  renderDirection: RenderTextDirection;
};

/**
 * Build finite, reading-order slot plans for shape-aware text wrapping.
 *
 * Every line band must be covered across its complete line height. Its usable
 * inline interval is the intersection of all scanline spans touched by that
 * band, which prevents glyphs from leaking into a balloon's curved edges.
 *
 * A plan ends in one region. Earlier regions use their maximum centered
 * capacity, while the terminal region is tried from one centered line upward.
 * This naturally flows fused balloon lobes in their stored reading order.
 */
export function resolveBubbleTextSlotPlans(
  value: unknown,
  input: BubbleSlotPlanInput,
): TextLineSlot[][] {
  if (!isBubbleLayoutEligible(value, input)) return [];
  const layout =
    resolveDisjointBubbleLayout(value, {
      blockExtentPx: input.blockExtentPx,
      inlineExtentPx: input.inlineExtentPx,
    }) ?? value;
  const maximumSlotCount = resolveMaximumSlotCount(input.maximumSlotCount);
  const regionPlans = layout.regions.map((region, regionIndex) =>
    resolveRegionSlotPlans(region, regionIndex, input, maximumSlotCount),
  );
  return combineRegionSlotPlans(regionPlans, maximumSlotCount);
}

export function resolveBubbleRegionLineInterval(
  region: BubbleShapeRegion,
  blockStart: number,
  blockEnd: number,
): { inlineStart: number; inlineEnd: number } | null {
  return intersectBubbleRegionLineBand(region, blockStart, blockEnd);
}

function isBubbleLayoutEligible(
  value: unknown,
  input: BubbleSlotPlanInput,
): value is BubbleLayout {
  return (
    isUsableBubbleLayout(value) &&
    value.direction === input.renderDirection &&
    isPositiveFinite(input.blockExtentPx) &&
    isPositiveFinite(input.inlineExtentPx) &&
    isPositiveFinite(input.fontWidthScale) &&
    isPositiveFinite(input.lineHeightPx)
  );
}

function resolveRegionSlotPlans(
  region: BubbleShapeRegion,
  regionIndex: number,
  input: BubbleSlotPlanInput,
  maximumSlotCount: number,
): TextLineSlot[][] {
  const first = region.spans[0];
  const last = region.spans.at(-1);
  if (!first || !last) return [];
  const regionStartPx = first.blockStart * input.blockExtentPx;
  const regionEndPx = last.blockEnd * input.blockExtentPx;
  const regionExtentPx = Math.max(0, regionEndPx - regionStartPx);
  const maximumLineCount = Math.min(
    maximumSlotCount,
    Math.floor((regionExtentPx + COORDINATE_EPSILON) / input.lineHeightPx),
  );
  const plans: TextLineSlot[][] = [];
  for (let lineCount = 1; lineCount <= maximumLineCount; lineCount += 1) {
    const plan = resolveCenteredRegionPlan(
      region,
      regionIndex,
      lineCount,
      regionStartPx,
      regionEndPx,
      input,
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
  input: BubbleSlotPlanInput,
): TextLineSlot[] | null {
  const contentExtentPx = lineCount * input.lineHeightPx;
  const blockOffsetPx = (regionStartPx + regionEndPx - contentExtentPx) / 2;
  if (
    blockOffsetPx < regionStartPx - COORDINATE_EPSILON ||
    blockOffsetPx + contentExtentPx > regionEndPx + COORDINATE_EPSILON
  ) {
    return null;
  }

  const slots: TextLineSlot[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    // CSS vertical-rl consumes columns from right to left. Bubble spans remain
    // normalized left-to-right, so reverse only the column order; stored
    // region order still controls flow across fused balloon lobes.
    const bandIndex =
      input.renderDirection === "vertical" ? lineCount - index - 1 : index;
    const lineStartPx = blockOffsetPx + bandIndex * input.lineHeightPx;
    const lineEndPx = lineStartPx + input.lineHeightPx;
    const interval = resolveBubbleRegionLineInterval(
      region,
      clampRatio(lineStartPx / input.blockExtentPx),
      clampRatio(lineEndPx / input.blockExtentPx),
    );
    if (!interval) return null;
    slots.push({
      blockOffsetPx:
        input.renderDirection === "vertical"
          ? lineStartPx / input.fontWidthScale
          : lineStartPx,
      inlineOffsetPx:
        (interval.inlineStart * input.inlineExtentPx) /
        (input.renderDirection === "horizontal" ? input.fontWidthScale : 1),
      availableWidth:
        ((interval.inlineEnd - interval.inlineStart) * input.inlineExtentPx) /
        (input.renderDirection === "horizontal" ? input.fontWidthScale : 1),
      regionIndex,
    });
  }
  return slots;
}

/**
 * Plans are ordered by the exact number of slots they expose. For the same
 * count, plans spanning the largest reading-order prefix win. Consequently a
 * two-line/two-region translation tries [1, 1] before [2, 0], while a one-line
 * translation still has the safe first-region fallback.
 */
function combineRegionSlotPlans(
  regionPlans: TextLineSlot[][][],
  maximumSlotCount: number,
): TextLineSlot[][] {
  return combineBubbleRegionPlanPrefixes(
    regionPlans,
    maximumSlotCount,
    MAX_PLANS_PER_SLOT_COUNT,
  );
}

function resolveMaximumSlotCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return MAX_BUBBLE_TEXT_LINES;
  return Math.max(
    1,
    Math.min(MAX_BUBBLE_TEXT_LINES, Math.floor(value as number)),
  );
}

function clampRatio(value: number): number {
  if (Math.abs(value) <= COORDINATE_EPSILON) return 0;
  if (Math.abs(1 - value) <= COORDINATE_EPSILON) return 1;
  return value;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
