import type { BBox } from "../../shared/textTypes";
import type { RefinedBubbleRegion } from "./bubbleMaskTypes";
import {
  retainLargestMaskComponent,
  tightenBubbleRegion,
} from "./bubbleSameBlockRegionRaster";

type PartitionAxis = "x" | "y";

type WorkingRegion = {
  source: RefinedBubbleRegion;
  mask: Uint8Array;
  changed: boolean;
};

type MaskGeometry = {
  area: number;
  centerX: number;
  centerY: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/**
 * Detector crops for two connected lobes can overlap even though they belong
 * to one OCR block. Keep their reading-order entries, but reserve a small
 * empty band between the masks before they are converted to layout spans.
 */
export function partitionSameBlockBubbleRegions(
  regions: readonly RefinedBubbleRegion[],
  requestedGapPx: number,
): RefinedBubbleRegion[] {
  if (regions.length < 2) return [...regions];
  const gapPx = resolveGapPx(requestedGapPx);
  const working = regions.map<WorkingRegion>((source) => ({
    source,
    mask: source.mask.slice(),
    changed: false,
  }));

  for (let leftIndex = 0; leftIndex < working.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < working.length;
      rightIndex += 1
    ) {
      separatePair(working, leftIndex, rightIndex, gapPx);
    }
  }

  return working.flatMap((region) => {
    if (!region.changed) return [region.source];
    const connectedMask = retainLargestMaskComponent(
      region.mask,
      region.source.width,
      region.source.height,
    );
    const tightened = tightenBubbleRegion(region.source, connectedMask);
    return tightened ? [tightened] : [];
  });
}

function separatePair(
  regions: WorkingRegion[],
  leftIndex: number,
  rightIndex: number,
  gapPx: number,
): void {
  const left = regions[leftIndex];
  const right = regions[rightIndex];
  if (!masksNeedGutter(left, right, gapPx)) return;

  const leftGeometry = measureMaskGeometry(left);
  const rightGeometry = measureMaskGeometry(right);
  if (!leftGeometry || !rightGeometry) return;
  const axis = choosePartitionAxis(leftGeometry, rightGeometry);
  const ordered =
    compareAlongAxis(leftGeometry, rightGeometry, axis) <= 0
      ? {
          lower: left,
          lowerGeometry: leftGeometry,
          upper: right,
          upperGeometry: rightGeometry,
        }
      : {
          lower: right,
          lowerGeometry: rightGeometry,
          upper: left,
          upperGeometry: leftGeometry,
        };
  const cut = resolvePartitionCut(
    ordered.lowerGeometry,
    ordered.upperGeometry,
    axis,
    gapPx,
  );
  if (cut === null) {
    discardSmallerRegion(left, leftGeometry, right, rightGeometry);
    return;
  }

  const lowerChanged = trimMaskAtUpperLimit(
    ordered.lower,
    axis,
    cut - gapPx / 2,
  );
  const upperChanged = trimMaskAtLowerLimit(
    ordered.upper,
    axis,
    cut + gapPx / 2,
  );
  ordered.lower.changed ||= lowerChanged;
  ordered.upper.changed ||= upperChanged;
}

function masksNeedGutter(
  left: WorkingRegion,
  right: WorkingRegion,
  gapPx: number,
): boolean {
  if (boxEdgeDistance(left.source.bounds, right.source.bounds) >= gapPx) {
    return false;
  }
  const searchRadius = Math.ceil(gapPx) + 1;
  const leftOriginX = Math.round(left.source.bounds.x);
  const leftOriginY = Math.round(left.source.bounds.y);
  const rightOriginX = Math.round(right.source.bounds.x);
  const rightOriginY = Math.round(right.source.bounds.y);
  for (const { x, y } of activePagePixels(left, leftOriginX, leftOriginY)) {
    if (
      hasNearbyMaskPixel(
        right,
        x,
        y,
        rightOriginX,
        rightOriginY,
        searchRadius,
        gapPx,
      )
    ) {
      return true;
    }
  }
  return false;
}

function* activePagePixels(
  region: WorkingRegion,
  originX: number,
  originY: number,
): Generator<{ x: number; y: number }> {
  for (let y = 0; y < region.source.height; y += 1) {
    for (let x = 0; x < region.source.width; x += 1) {
      if (region.mask[y * region.source.width + x]) {
        yield { x: originX + x, y: originY + y };
      }
    }
  }
}

function hasNearbyMaskPixel(
  region: WorkingRegion,
  pageX: number,
  pageY: number,
  originX: number,
  originY: number,
  searchRadius: number,
  gapPx: number,
): boolean {
  for (let offsetY = -searchRadius; offsetY <= searchRadius; offsetY += 1) {
    for (let offsetX = -searchRadius; offsetX <= searchRadius; offsetX += 1) {
      if (
        pixelEdgeDistance(offsetX, offsetY) < gapPx &&
        readPageMask(region, pageX + offsetX, pageY + offsetY, originX, originY)
      ) {
        return true;
      }
    }
  }
  return false;
}

function choosePartitionAxis(
  left: MaskGeometry,
  right: MaskGeometry,
): PartitionAxis {
  const averageWidth = Math.max(
    1,
    (left.maxX - left.minX + (right.maxX - right.minX)) / 2,
  );
  const averageHeight = Math.max(
    1,
    (left.maxY - left.minY + (right.maxY - right.minY)) / 2,
  );
  const horizontalSeparation =
    Math.abs(left.centerX - right.centerX) / averageWidth;
  const verticalSeparation =
    Math.abs(left.centerY - right.centerY) / averageHeight;
  return horizontalSeparation >= verticalSeparation ? "x" : "y";
}

function compareAlongAxis(
  left: MaskGeometry,
  right: MaskGeometry,
  axis: PartitionAxis,
): number {
  const primary =
    axis === "x" ? left.centerX - right.centerX : left.centerY - right.centerY;
  if (primary !== 0) return primary;
  return axis === "x"
    ? left.centerY - right.centerY
    : left.centerX - right.centerX;
}

function resolvePartitionCut(
  lower: MaskGeometry,
  upper: MaskGeometry,
  axis: PartitionAxis,
  gapPx: number,
): number | null {
  const lowerMinimum = axis === "x" ? lower.minX : lower.minY;
  const lowerMaximum = axis === "x" ? lower.maxX : lower.maxY;
  const upperMinimum = axis === "x" ? upper.minX : upper.minY;
  const upperMaximum = axis === "x" ? upper.maxX : upper.maxY;
  const minimumCut = lowerMinimum + 1 + gapPx / 2;
  const maximumCut = upperMaximum - 1 - gapPx / 2;
  if (minimumCut > maximumCut) return null;
  const idealCut = (lowerMaximum + upperMinimum) / 2;
  return clamp(idealCut, minimumCut, maximumCut);
}

function trimMaskAtUpperLimit(
  region: WorkingRegion,
  axis: PartitionAxis,
  limit: number,
): boolean {
  let changed = false;
  const origin = Math.round(
    axis === "x" ? region.source.bounds.x : region.source.bounds.y,
  );
  for (let y = 0; y < region.source.height; y += 1) {
    for (let x = 0; x < region.source.width; x += 1) {
      const index = y * region.source.width + x;
      if (!region.mask[index]) continue;
      const farEdge = origin + (axis === "x" ? x : y) + 1;
      if (farEdge <= limit) continue;
      region.mask[index] = 0;
      changed = true;
    }
  }
  return changed;
}

function trimMaskAtLowerLimit(
  region: WorkingRegion,
  axis: PartitionAxis,
  limit: number,
): boolean {
  let changed = false;
  const origin = Math.round(
    axis === "x" ? region.source.bounds.x : region.source.bounds.y,
  );
  for (let y = 0; y < region.source.height; y += 1) {
    for (let x = 0; x < region.source.width; x += 1) {
      const index = y * region.source.width + x;
      if (!region.mask[index]) continue;
      const nearEdge = origin + (axis === "x" ? x : y);
      if (nearEdge >= limit) continue;
      region.mask[index] = 0;
      changed = true;
    }
  }
  return changed;
}

function discardSmallerRegion(
  left: WorkingRegion,
  leftGeometry: MaskGeometry,
  right: WorkingRegion,
  rightGeometry: MaskGeometry,
): void {
  const discarded = leftGeometry.area < rightGeometry.area ? left : right;
  discarded.mask.fill(0);
  discarded.changed = true;
}

function measureMaskGeometry(region: WorkingRegion): MaskGeometry | null {
  const originX = Math.round(region.source.bounds.x);
  const originY = Math.round(region.source.bounds.y);
  let area = 0;
  let totalX = 0;
  let totalY = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < region.source.height; y += 1) {
    for (let x = 0; x < region.source.width; x += 1) {
      if (!region.mask[y * region.source.width + x]) continue;
      const pageX = originX + x;
      const pageY = originY + y;
      area += 1;
      totalX += pageX + 0.5;
      totalY += pageY + 0.5;
      minX = Math.min(minX, pageX);
      minY = Math.min(minY, pageY);
      maxX = Math.max(maxX, pageX + 1);
      maxY = Math.max(maxY, pageY + 1);
    }
  }
  return area > 0
    ? {
        area,
        centerX: totalX / area,
        centerY: totalY / area,
        minX,
        minY,
        maxX,
        maxY,
      }
    : null;
}

function readPageMask(
  region: WorkingRegion,
  pageX: number,
  pageY: number,
  originX: number,
  originY: number,
): number {
  const localX = pageX - originX;
  const localY = pageY - originY;
  if (
    localX < 0 ||
    localY < 0 ||
    localX >= region.source.width ||
    localY >= region.source.height
  ) {
    return 0;
  }
  return region.mask[localY * region.source.width + localX] ?? 0;
}

function boxEdgeDistance(left: BBox, right: BBox): number {
  const gapX = Math.max(
    0,
    Math.max(left.x, right.x) - Math.min(left.x + left.w, right.x + right.w),
  );
  const gapY = Math.max(
    0,
    Math.max(left.y, right.y) - Math.min(left.y + left.h, right.y + right.h),
  );
  return Math.hypot(gapX, gapY);
}

function pixelEdgeDistance(offsetX: number, offsetY: number): number {
  return Math.hypot(
    Math.max(0, Math.abs(offsetX) - 1),
    Math.max(0, Math.abs(offsetY) - 1),
  );
}

function resolveGapPx(value: number): number {
  return Number.isFinite(value) ? clamp(value, 3, 6) : 3;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
