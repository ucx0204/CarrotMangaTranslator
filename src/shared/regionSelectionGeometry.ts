import type { BBox } from "./textTypes";
import { clamp } from "./bboxNormalization";

export type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export const RESIZE_DIRECTIONS: ResizeDirection[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

export function moveBbox(bbox: BBox, dx: number, dy: number): BBox {
  return {
    ...bbox,
    x: clamp(bbox.x + dx, 0, 1000 - bbox.w),
    y: clamp(bbox.y + dy, 0, 1000 - bbox.h),
  };
}

export function resizeBbox(
  bbox: BBox,
  direction: ResizeDirection,
  dx: number,
  dy: number,
): BBox {
  let left = bbox.x;
  let top = bbox.y;
  let right = bbox.x + bbox.w;
  let bottom = bbox.y + bbox.h;
  const minWidth = Math.min(2, bbox.w);
  const minHeight = Math.min(2, bbox.h);
  if (direction.includes("w")) left = clamp(left + dx, 0, right - minWidth);
  if (direction.includes("e")) right = clamp(right + dx, left + minWidth, 1000);
  if (direction.includes("n")) top = clamp(top + dy, 0, bottom - minHeight);
  if (direction.includes("s"))
    bottom = clamp(bottom + dy, top + minHeight, 1000);
  return { x: left, y: top, w: right - left, h: bottom - top };
}
