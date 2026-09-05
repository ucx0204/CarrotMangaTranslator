import type { BBox } from "../../shared/textTypes";
import type {
  BlockBubbleCandidate,
  BubbleOwnershipPartition,
} from "./bubbleBlockAssociation";
import type { RefinedBubbleRegion } from "./bubbleMaskTypes";
import { isMaskOwnedPoint } from "./bubbleMaskOwnership";

const TEXT_SHAPE_WEIGHT = 0.78;
const MIN_TEXT_RADIUS_SCALE = 0.55;
const MAX_TEXT_RADIUS_SCALE = 1.8;
const OWNERSHIP_GUTTER_SCALE = 1.5;

export function resolveBubblePartitionGapPx(
  imageWidth: number,
  imageHeight: number,
): number {
  return clamp(Math.round(Math.min(imageWidth, imageHeight) * 0.0035), 3, 6);
}

export function clipRegionsToOwnershipPartition(
  regions: readonly RefinedBubbleRegion[],
  partition: BubbleOwnershipPartition | undefined,
): RefinedBubbleRegion[] {
  if (!partition) return [...regions];
  return regions.flatMap((region) => {
    const clipped = clipRegionToOwnershipCell(region, partition);
    return clipped ? [clipped] : [];
  });
}

export function buildOwnershipFallbackRegion(
  candidate: BlockBubbleCandidate,
  insetPx: number,
  allowUnpartitioned = false,
): RefinedBubbleRegion | null {
  const partition = candidate.ownershipPartition;
  if (!partition && !allowUnpartitioned) return null;
  const fallbackBounds = insetPartitionBox(candidate.bubbleBox, insetPx);
  if (!fallbackBounds || fallbackBounds.w < 2 || fallbackBounds.h < 2) {
    return null;
  }
  const x = Math.ceil(fallbackBounds.x);
  const y = Math.ceil(fallbackBounds.y);
  const right = Math.floor(fallbackBounds.x + fallbackBounds.w);
  const bottom = Math.floor(fallbackBounds.y + fallbackBounds.h);
  const width = Math.max(0, right - x);
  const height = Math.max(0, bottom - y);
  if (width < 2 || height < 2) return null;
  const mask = buildEllipseMask(width, height);
  const area = countMask(mask);
  if (area < 4) return null;
  const ellipse = {
    bounds: { x, y, w: width, h: height },
    width,
    height,
    area,
    mask,
  };
  return partition ? clipRegionToOwnershipCell(ellipse, partition) : ellipse;
}

function buildEllipseMask(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const radiusX = Math.max(0.5, width / 2);
  const radiusY = Math.max(0.5, height / 2);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (x - centerX) / radiusX;
      const dy = (y - centerY) / radiusY;
      if (dx * dx + dy * dy <= 1) {
        mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

function countMask(mask: Uint8Array): number {
  let area = 0;
  for (const value of mask) area += value;
  return area;
}

function clipRegionToOwnershipCell(
  region: RefinedBubbleRegion,
  partition: BubbleOwnershipPartition,
): RefinedBubbleRegion | null {
  const mask = new Uint8Array(region.width * region.height);
  let area = 0;
  for (let localY = 0; localY < region.height; localY += 1) {
    for (let localX = 0; localX < region.width; localX += 1) {
      const sourceIndex = localY * region.width + localX;
      if (!region.mask[sourceIndex]) continue;
      const pageX = region.bounds.x + localX + 0.5;
      const pageY = region.bounds.y + localY + 0.5;
      if (
        shouldApplyOwnershipAtPoint(pageX, pageY, partition) &&
        !isOwnedPartitionPoint(pageX, pageY, partition)
      ) {
        continue;
      }
      mask[sourceIndex] = 1;
      area += 1;
    }
  }
  return trimRegionToMask({
    bounds: { ...region.bounds },
    width: region.width,
    height: region.height,
    area,
    mask,
  });
}

function shouldApplyOwnershipAtPoint(
  x: number,
  y: number,
  partition: BubbleOwnershipPartition,
): boolean {
  return (
    partition.scope === "full" ||
    partition.competingBubbleBoxes.some((box) => isInsideEllipseBox(x, y, box))
  );
}

function isInsideEllipseBox(x: number, y: number, box: BBox): boolean {
  const radiusX = Math.max(0.5, box.w / 2);
  const radiusY = Math.max(0.5, box.h / 2);
  const centerX = box.x + box.w / 2;
  const centerY = box.y + box.h / 2;
  const dx = (x - centerX) / radiusX;
  const dy = (y - centerY) / radiusY;
  return dx * dx + dy * dy <= 1;
}

function isOwnedPartitionPoint(
  x: number,
  y: number,
  partition: BubbleOwnershipPartition,
): boolean {
  if (partition.maskOwnership) {
    const owned = isMaskOwnedPoint(
      partition.maskOwnership,
      x,
      y,
      partition.gapPx,
    );
    if (owned !== null) return owned;
  }
  return partition.competingOwnerBoxes.every((competingOwnerBox) =>
    isOwnedAgainstCompetingText(
      x,
      y,
      partition.ownerBox,
      competingOwnerBox,
      partition.scope === "bubble-overlap" ? 0 : partition.gapPx,
    ),
  );
}

/**
 * Compare regularized elliptical influence fields centered on the OCR boxes.
 * Unlike a point/capsule Voronoi split, differently sized text fields produce
 * curved conic bisectors. A shared radial term prevents a large OCR box from
 * swallowing a smaller neighbor while keeping the result symmetric.
 */
function isOwnedAgainstCompetingText(
  x: number,
  y: number,
  ownerBox: BBox,
  competingOwnerBox: BBox,
  gapPx: number,
): boolean {
  const sharedScale = Math.max(
    4,
    (Math.sqrt(ownerBox.w * ownerBox.h) +
      Math.sqrt(competingOwnerBox.w * competingOwnerBox.h)) /
      4,
  );
  const ownerDistance = distanceToTextInfluence(x, y, ownerBox, sharedScale);
  const competitorDistance = distanceToTextInfluence(
    x,
    y,
    competingOwnerBox,
    sharedScale,
  );
  return (
    ownerDistance + (gapPx * OWNERSHIP_GUTTER_SCALE) / sharedScale <=
    competitorDistance
  );
}

function distanceToTextInfluence(
  x: number,
  y: number,
  box: BBox,
  sharedScale: number,
): number {
  const centerX = box.x + box.w / 2;
  const centerY = box.y + box.h / 2;
  const dx = x - centerX;
  const dy = y - centerY;
  const radiusX = clamp(
    box.w / 2,
    sharedScale * MIN_TEXT_RADIUS_SCALE,
    sharedScale * MAX_TEXT_RADIUS_SCALE,
  );
  const radiusY = clamp(
    box.h / 2,
    sharedScale * MIN_TEXT_RADIUS_SCALE,
    sharedScale * MAX_TEXT_RADIUS_SCALE,
  );
  const ellipticalDistance = Math.hypot(dx / radiusX, dy / radiusY);
  const radialDistance = Math.hypot(dx, dy) / sharedScale;
  return (
    ellipticalDistance * TEXT_SHAPE_WEIGHT +
    radialDistance * (1 - TEXT_SHAPE_WEIGHT)
  );
}

function trimRegionToMask(
  region: RefinedBubbleRegion,
): RefinedBubbleRegion | null {
  if (region.area <= 0) return null;
  const activeBounds = findActiveMaskBounds(region);
  if (!activeBounds) return null;
  const { left, top, right, bottom } = activeBounds;
  const width = right - left + 1;
  const height = bottom - top + 1;
  if (
    left === 0 &&
    top === 0 &&
    width === region.width &&
    height === region.height
  ) {
    return region;
  }
  return copyMaskWindow(region, left, top, width, height);
}

function findActiveMaskBounds(region: RefinedBubbleRegion): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} | null {
  let left = region.width;
  let top = region.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      if (!region.mask[y * region.width + x]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left || bottom < top ? null : { left, top, right, bottom };
}

function copyMaskWindow(
  region: RefinedBubbleRegion,
  left: number,
  top: number,
  width: number,
  height: number,
): RefinedBubbleRegion {
  const mask = new Uint8Array(width * height);
  let area = 0;
  for (let y = 0; y < height; y += 1) {
    const sourceOffset = (top + y) * region.width + left;
    const targetOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      const value = region.mask[sourceOffset + x] ?? 0;
      mask[targetOffset + x] = value;
      area += value;
    }
  }
  return {
    bounds: {
      x: region.bounds.x + left,
      y: region.bounds.y + top,
      w: width,
      h: height,
    },
    width,
    height,
    area,
    mask,
  };
}

function insetPartitionBox(
  box: BBox | null,
  requestedInsetPx: number,
): BBox | null {
  if (!box) return null;
  const maximumInset = Math.max(0, Math.min(box.w, box.h) / 2 - 1);
  const inset = Math.min(Math.max(0, requestedInsetPx), maximumInset);
  return {
    x: box.x + inset,
    y: box.y + inset,
    w: box.w - inset * 2,
    h: box.h - inset * 2,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
