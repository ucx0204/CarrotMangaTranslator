import {
  normalizeBbox,
  type NormalizedBbox,
  type PageGeometryItem,
} from "./automaticFontMatchingV2PageConsistencyShared";

const MINIMUM_COMPONENT_BODY_AREA_RATIO = 0.55;
const MINIMUM_COMPONENT_SPAN_RATIO = 0.6;
const MINIMUM_SPLIT_AXIS_OVERLAP = 0.8;
const MAXIMUM_SPLIT_GAP = 8;
const MAXIMUM_RELATIVE_SPLIT_GAP = 0.08;
const MINIMUM_WIDE_VARIANT_ASPECT_RATIO = 3.2;
const MAXIMUM_TINY_VARIANT_SHORT_EDGE = 16;
const MAXIMUM_TINY_VARIANT_AREA = 500;
const MAXIMUM_NARROW_VERTICAL_ASPECT_RATIO = 0.55;
const MAXIMUM_NARROW_VERTICAL_WIDTH = 64;
const MAXIMUM_COMPACT_CORNER_OFFSET = 64;
const MAXIMUM_COMPACT_CORNER_EDGE = 140;
const MINIMUM_COMPACT_CORNER_ASPECT_RATIO = 0.75;

type SplitGeometryMetrics = {
  left: NormalizedBbox;
  right: NormalizedBbox;
  horizontalGap: number;
  verticalGap: number;
  horizontalOverlap: number;
  verticalOverlap: number;
  sideGapLimit: number;
  stackGapLimit: number;
  areaRatio: number;
  verticalSpanRatio: number;
  horizontalSpanRatio: number;
};

export function hasVariantGeometry(
  item: PageGeometryItem | undefined,
): boolean {
  const bbox = normalizeBbox(item?.bbox);
  if (!bbox) return false;
  const aspectRatio = bbox.w / bbox.h;
  return (
    isTinyVariant(bbox) ||
    isWideVariant(item, aspectRatio) ||
    isCompactVerticalVariant(item, bbox, aspectRatio) ||
    isCompactTopLeftVariant(bbox, aspectRatio)
  );
}

export function isLikelySplitGeometryPair(
  leftItem: PageGeometryItem | undefined,
  rightItem: PageGeometryItem | undefined,
): boolean {
  const metrics = resolveSplitGeometryMetrics(leftItem, rightItem);
  if (!metrics) return false;
  return isSideBySideSplit(metrics) || isStackedSplit(metrics);
}

function isTinyVariant(bbox: NormalizedBbox): boolean {
  return (
    Math.min(bbox.w, bbox.h) <= MAXIMUM_TINY_VARIANT_SHORT_EDGE &&
    bbox.w * bbox.h <= MAXIMUM_TINY_VARIANT_AREA
  );
}

function isWideVariant(
  item: PageGeometryItem | undefined,
  aspectRatio: number,
): boolean {
  return (
    item?.direction === "horizontal" &&
    aspectRatio >= MINIMUM_WIDE_VARIANT_ASPECT_RATIO
  );
}

function isCompactVerticalVariant(
  item: PageGeometryItem | undefined,
  bbox: NormalizedBbox,
  aspectRatio: number,
): boolean {
  if (item?.direction !== "vertical") return false;
  if (bbox.w > MAXIMUM_NARROW_VERTICAL_WIDTH) return false;
  return (
    aspectRatio <= MAXIMUM_NARROW_VERTICAL_ASPECT_RATIO ||
    bbox.h <= MAXIMUM_COMPACT_CORNER_EDGE
  );
}

function isCompactTopLeftVariant(
  bbox: NormalizedBbox,
  aspectRatio: number,
): boolean {
  if (bbox.x > MAXIMUM_COMPACT_CORNER_OFFSET) return false;
  if (bbox.y > MAXIMUM_COMPACT_CORNER_OFFSET) return false;
  if (Math.max(bbox.w, bbox.h) > MAXIMUM_COMPACT_CORNER_EDGE) return false;
  return (
    aspectRatio >= MINIMUM_COMPACT_CORNER_ASPECT_RATIO &&
    aspectRatio <= 1 / MINIMUM_COMPACT_CORNER_ASPECT_RATIO
  );
}

function resolveSplitGeometryMetrics(
  leftItem: PageGeometryItem | undefined,
  rightItem: PageGeometryItem | undefined,
): SplitGeometryMetrics | null {
  const left = normalizeBbox(leftItem?.bbox);
  const right = normalizeBbox(rightItem?.bbox);
  if (!left || !right) return null;
  if (!haveCompatibleDirections(leftItem, rightItem)) return null;
  if (!haveCompatibleTypes(leftItem, rightItem)) return null;
  return buildSplitGeometryMetrics(left, right);
}

function haveCompatibleDirections(
  left: PageGeometryItem | undefined,
  right: PageGeometryItem | undefined,
): boolean {
  if (!left?.direction || !right?.direction) return true;
  return left.direction === right.direction;
}

function haveCompatibleTypes(
  left: PageGeometryItem | undefined,
  right: PageGeometryItem | undefined,
): boolean {
  const leftType = String(left?.type ?? "").trim();
  const rightType = String(right?.type ?? "").trim();
  return !leftType || !rightType || leftType === rightType;
}

function buildSplitGeometryMetrics(
  left: NormalizedBbox,
  right: NormalizedBbox,
): SplitGeometryMetrics {
  return {
    left,
    right,
    horizontalGap: axisGap(left.x, left.x + left.w, right.x, right.x + right.w),
    verticalGap: axisGap(left.y, left.y + left.h, right.y, right.y + right.h),
    horizontalOverlap: axisOverlap(
      left.x,
      left.x + left.w,
      right.x,
      right.x + right.w,
    ),
    verticalOverlap: axisOverlap(
      left.y,
      left.y + left.h,
      right.y,
      right.y + right.h,
    ),
    sideGapLimit: resolveGapLimit(left.w, right.w),
    stackGapLimit: resolveGapLimit(left.h, right.h),
    areaRatio: ratio(left.w * left.h, right.w * right.h),
    verticalSpanRatio: ratio(left.h, right.h),
    horizontalSpanRatio: ratio(left.w, right.w),
  };
}

function isSideBySideSplit(metrics: SplitGeometryMetrics): boolean {
  const overlap =
    metrics.verticalOverlap / Math.min(metrics.left.h, metrics.right.h);
  return (
    overlap >= MINIMUM_SPLIT_AXIS_OVERLAP &&
    metrics.verticalSpanRatio >= MINIMUM_COMPONENT_SPAN_RATIO &&
    metrics.areaRatio <= MINIMUM_COMPONENT_BODY_AREA_RATIO &&
    metrics.horizontalGap <= metrics.sideGapLimit
  );
}

function isStackedSplit(metrics: SplitGeometryMetrics): boolean {
  const overlap =
    metrics.horizontalOverlap / Math.min(metrics.left.w, metrics.right.w);
  return (
    overlap >= MINIMUM_SPLIT_AXIS_OVERLAP &&
    metrics.horizontalSpanRatio >= MINIMUM_COMPONENT_SPAN_RATIO &&
    metrics.areaRatio <= MINIMUM_COMPONENT_BODY_AREA_RATIO &&
    metrics.verticalGap <= metrics.stackGapLimit
  );
}

function resolveGapLimit(leftSpan: number, rightSpan: number): number {
  return Math.max(
    MAXIMUM_SPLIT_GAP,
    Math.min(leftSpan, rightSpan) * MAXIMUM_RELATIVE_SPLIT_GAP,
  );
}

function ratio(left: number, right: number): number {
  return Math.min(left, right) / Math.max(left, right);
}

function axisGap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): number {
  return Math.max(
    0,
    Math.max(leftStart, rightStart) - Math.min(leftEnd, rightEnd),
  );
}

function axisOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): number {
  return Math.max(
    0,
    Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart),
  );
}
