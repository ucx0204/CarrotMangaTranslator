import type { InpaintingWindowMask } from "./inpaintingEngine";
import { buildLocalMask } from "./imageRaster";
import type { PixelRect } from "./maskGeometry";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";

/**
 * Extends a shared balloon's safe mask only across nearby detected glyphs.
 * This removes split seams without filling the entire gap between blocks.
 */
export function extendSharedBubbleMaskWithDetectedText(
  bubbleMask: InpaintingWindowMask,
  detectedMask: InpaintingWindowMask | undefined,
  supportRect: PixelRect,
  bridgeRadius: number,
): InpaintingWindowMask {
  if (!detectedMask) return bubbleMask;
  const bounds = unionRects(bubbleMask.bounds, detectedMask.bounds);
  const data = projectWindowMask(bubbleMask, bounds);
  const detected = projectWindowMask(detectedMask, bounds);
  const nearBubble = buildLocalMask(
    data,
    bounds.w,
    { x: 0, y: 0, w: bounds.w, h: bounds.h },
    bridgeRadius,
  );
  mergeNearbyDetectedText(data, detected, nearBubble, bounds, supportRect);
  return trimWindowMask({ bounds, data }) ?? bubbleMask;
}

function mergeNearbyDetectedText(
  data: Uint8Array,
  detected: Uint8Array,
  nearBubble: Uint8Array,
  bounds: PixelRect,
  supportRect: PixelRect,
): void {
  const left = Math.max(0, supportRect.x - bounds.x);
  const top = Math.max(0, supportRect.y - bounds.y);
  const right = Math.min(bounds.w, supportRect.x + supportRect.w - bounds.x);
  const bottom = Math.min(bounds.h, supportRect.y + supportRect.h - bounds.y);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = y * bounds.w + x;
      if (detected[index] && nearBubble[index]) data[index] = 1;
    }
  }
}

function trimWindowMask(
  windowMask: InpaintingWindowMask,
): InpaintingWindowMask | null {
  const edges = findMaskEdges(windowMask);
  if (!edges) return null;
  const { bounds, data } = windowMask;
  const { left, top, right, bottom } = edges;
  if (
    left === 0 &&
    top === 0 &&
    right === bounds.w - 1 &&
    bottom === bounds.h - 1
  ) {
    return windowMask;
  }
  const width = right - left + 1;
  const height = bottom - top + 1;
  const trimmed = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = (top + y) * bounds.w + left;
    trimmed.set(data.subarray(sourceStart, sourceStart + width), y * width);
  }
  return {
    bounds: {
      x: bounds.x + left,
      y: bounds.y + top,
      w: width,
      h: height,
    },
    data: trimmed,
  };
}

function findMaskEdges(windowMask: InpaintingWindowMask): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} | null {
  const { bounds, data } = windowMask;
  let left = bounds.w;
  let top = bounds.h;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < bounds.h; y += 1) {
    for (let x = 0; x < bounds.w; x += 1) {
      if (!data[y * bounds.w + x]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left || bottom < top ? null : { left, top, right, bottom };
}

function unionRects(left: PixelRect, right: PixelRect): PixelRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.w, right.x + right.w);
  const bottomEdge = Math.max(left.y + left.h, right.y + right.h);
  return { x, y, w: rightEdge - x, h: bottomEdge - y };
}
