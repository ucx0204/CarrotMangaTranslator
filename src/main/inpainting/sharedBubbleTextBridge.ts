import { printMaskGrid } from "./qwenPrintedPigment";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
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

type PrintGrid = ReturnType<typeof printMaskGrid>;
type PrintComponent = ReturnType<PrintGrid["components"]>[number];

function framePoint(frame: PixelRect, i: number) {
  return { x: frame.x + (i % frame.w), y: frame.y + Math.floor(i / frame.w) };
}
function neutralTones(bitmap: Buffer, width: number, frame: PixelRect) {
  const tones = new Uint8Array(frame.w * frame.h);
  for (let i = 0; i < tones.length; i++) {
    const { x, y } = framePoint(frame, i),
      p = 4 * (y * width + x);
    const lo = Math.min(bitmap[p], bitmap[p + 1], bitmap[p + 2]);
    if (
      bitmap[p + 3] !== 255 ||
      Math.max(bitmap[p], bitmap[p + 1], bitmap[p + 2]) - lo > 4
    )
      return;
    tones[i] = lo;
  }
  return tones;
}
function boundedStroke(b: PixelRect, frame: PixelRect, maximum: number) {
  return (
    b.x > 0 &&
    b.y > 0 &&
    b.x + b.w < frame.w &&
    b.y + b.h < frame.h &&
    Math.max(b.w, b.h) <= maximum
  );
}
function strokePixels(part: PrintComponent, width: number) {
  const result: number[] = [],
    b = part.rect;
  part.data.forEach((on, i) => {
    if (on) result.push((b.y + Math.floor(i / b.w)) * width + b.x + (i % b.w));
  });
  return result;
}
function jointGlyphSupport(
  tones: Uint8Array,
  active: Uint8Array,
  frame: PixelRect,
  detected: Uint8Array,
) {
  const grid = printMaskGrid(frame.w, frame.h),
    reach = grid.distance(detected),
    ink = new Uint8Array(tones.length);
  let count = 0;
  for (const part of grid.components(
    tones.map((v) => Number(v < 211)),
    1,
  )) {
    if (!boundedStroke(part.rect, frame, Infinity)) continue;
    const pixels = strokePixels(part, frame.w);
    if (!pixels.some((i) => active[i])) continue;
    if (
      Math.max(part.rect.w, part.rect.h) > 48 ||
      !pixels.every((i) => active[i] && reach[i] <= 10)
    )
      return;
    const closest = pixels.reduce((v, i) => Math.min(v, reach[i]), Infinity);
    if (closest > (part.area < 32 ? 5 : 2.5)) return;
    count += Number(part.area >= 12);
    for (const i of pixels) ink[i] = 1;
  }
  if (count >= 8) return dilateBinaryMaskDisk(ink, frame.w, frame.h, 5);
}
export function measureJointBalloonPrint(
  bitmap: Buffer,
  width: number,
  boxes: PixelRect[],
  joint: PixelRect,
  frame: PixelRect,
  detected: Uint8Array,
) {
  const tones = neutralTones(bitmap, width, frame);
  if (!tones) return;
  const active = Uint8Array.from(tones, (_, i) =>
    Number(boxes.some((b) => pointInRect(framePoint(frame, i), b))),
  );
  const support = jointGlyphSupport(tones, active, frame, detected);
  if (!support) return;
  let bank = 0,
    white = 0;
  active.forEach((on, i) => {
    if (on && !support[i]) {
      bank++;
      white += Number(tones[i] >= 246);
    }
  });
  if (bank >= 0.32 * joint.w * joint.h && white >= 0.965 * bank)
    return { bounds: frame, data: support };
}
export function measuredPeerShoulder(
  bitmap: Buffer,
  width: number,
  frame: PixelRect,
  model: InpaintingWindowMask,
  peer: PixelRect,
) {
  const tones = neutralTones(bitmap, width, frame);
  if (
    !tones ||
    tones.reduce((n, v) => n + Number(v >= 248), 0) < 0.7 * tones.length
  )
    return;
  const tips = measurePeerTips(
    tones,
    frame,
    peer,
    projectWindowMask(model, frame),
  );
  if (!tips.some(Boolean)) return;
  const shoulder = projectWindowMask(
    { bounds: frame, data: dilateBinaryMaskDisk(tips, frame.w, frame.h, 3) },
    peer,
  );
  return { bounds: peer, data: shoulder.map((v) => Number(!v)) };
}
function measurePeerTips(
  tones: Uint8Array,
  frame: PixelRect,
  peer: PixelRect,
  selected: Uint8Array,
) {
  const dark = tones.map((v) => Number(v < 180)),
    tips = new Uint8Array(dark.length);
  for (const part of printMaskGrid(frame.w, frame.h).components(dark, 12)) {
    if (!boundedStroke(part.rect, frame, 55)) continue;
    const pixels = strokePixels(part, frame.w);
    let owned = 0,
      overlap = 0;
    for (const i of pixels) {
      owned += Number(!!selected[i]);
      overlap += Number(pointInRect(framePoint(frame, i), peer));
    }
    if (!overlap || overlap > 0.12 * part.area || owned < 0.88 * part.area)
      continue;
    for (const i of pixels) tips[i] = 1;
  }
  return tips;
}

function unionRects(left: PixelRect, right: PixelRect): PixelRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.w, right.x + right.w);
  const bottomEdge = Math.max(left.y + left.h, right.y + right.h);
  return { x, y, w: rightEdge - x, h: bottomEdge - y };
}

function pointInRect({ x, y }: { x: number; y: number }, rect: PixelRect) {
  return (
    x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
  );
}
