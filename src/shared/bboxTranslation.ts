import type { BBox } from "./textTypes";

export type BboxTranslation = { x: number; y: number };

export function clampTranslationToBboxes(
  bboxes: readonly BBox[],
  requestedDelta: BboxTranslation,
): BboxTranslation {
  if (bboxes.length === 0) {
    return { x: 0, y: 0 };
  }
  const minimumX = Math.max(...bboxes.map((bbox) => -bbox.x));
  const maximumX = Math.min(...bboxes.map((bbox) => 1000 - bbox.x - bbox.w));
  const minimumY = Math.max(...bboxes.map((bbox) => -bbox.y));
  const maximumY = Math.min(...bboxes.map((bbox) => 1000 - bbox.y - bbox.h));
  return {
    x: clamp(requestedDelta.x, minimumX, maximumX),
    y: clamp(requestedDelta.y, minimumY, maximumY),
  };
}

export function translateBbox(bbox: BBox, delta: BboxTranslation): BBox {
  return {
    ...bbox,
    x: bbox.x + delta.x,
    y: bbox.y + delta.y,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
