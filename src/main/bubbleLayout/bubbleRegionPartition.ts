import type { BBox } from "../../shared/textTypes";
import type {
  BlockBubbleCandidate,
  BubbleOwnershipPartition,
} from "./bubbleBlockAssociation";
import type { RefinedBubbleRegion } from "./bubbleMaskTypes";

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
    const clipped = clipRegionToBox(region, partition.clipBox);
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
  const fallbackBounds = insetPartitionBox(
    partition
      ? intersectionBox(candidate.bubbleBox, partition.clipBox)
      : candidate.bubbleBox,
    insetPx,
  );
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
  const mask = partition
    ? new Uint8Array(width * height).fill(1)
    : buildEllipseMask(width, height);
  const area = countMask(mask);
  if (area < 4) return null;
  return {
    bounds: { x, y, w: width, h: height },
    width,
    height,
    area,
    mask,
  };
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

function clipRegionToBox(
  region: RefinedBubbleRegion,
  clipBox: BBox,
): RefinedBubbleRegion | null {
  const bounds = intersectionBox(region.bounds, clipBox);
  if (!bounds) return null;
  const x = Math.ceil(bounds.x);
  const y = Math.ceil(bounds.y);
  const right = Math.floor(bounds.x + bounds.w);
  const bottom = Math.floor(bounds.y + bounds.h);
  const width = Math.max(0, right - x);
  const height = Math.max(0, bottom - y);
  if (width < 1 || height < 1) return null;
  const mask = new Uint8Array(width * height);
  let area = 0;
  for (let targetY = 0; targetY < height; targetY += 1) {
    for (let targetX = 0; targetX < width; targetX += 1) {
      const value = readRegionMask(region, x + targetX, y + targetY);
      mask[targetY * width + targetX] = value;
      area += value;
    }
  }
  return area > 0
    ? {
        bounds: { x, y, w: width, h: height },
        width,
        height,
        area,
        mask,
      }
    : null;
}

function readRegionMask(
  region: RefinedBubbleRegion,
  pageX: number,
  pageY: number,
): number {
  const sourceX = pageX - region.bounds.x;
  const sourceY = pageY - region.bounds.y;
  const isInBounds =
    Number.isInteger(sourceX) &&
    Number.isInteger(sourceY) &&
    sourceX >= 0 &&
    sourceY >= 0 &&
    sourceX < region.width &&
    sourceY < region.height;
  return isInBounds ? (region.mask[sourceY * region.width + sourceX] ?? 0) : 0;
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

function intersectionBox(left: BBox, right: BBox): BBox | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const farX = Math.min(left.x + left.w, right.x + right.w);
  const farY = Math.min(left.y + left.h, right.y + right.h);
  return farX > x && farY > y ? { x, y, w: farX - x, h: farY - y } : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
