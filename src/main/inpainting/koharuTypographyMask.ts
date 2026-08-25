import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import { resolveEffectiveTextOutlineWidthPx } from "../../shared/textOutline";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import {
  expandRect,
  resolvePatternBlockMarginPx,
  type PixelRect,
} from "./maskGeometry";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";

export type KoharuTypographyCompositeMask = {
  core: InpaintingWindowMask;
  featherEnvelope: InpaintingWindowMask;
  detectionCount: number;
  coreDilationPx: number;
};

/**
 * Converts Koharu text/SFX instance masks into a fully opaque erase core plus
 * an outer envelope used only by Flux's distance feather. The detector's raw
 * mask is deliberately thickened before feathering so outlined source glyphs
 * cannot survive as a bright fringe.
 */
export function buildKoharuTypographyCompositeMask(options: {
  block: TranslationBlock;
  featherPx: number;
  height: number;
  /**
   * Block-owned bubble region from the transient layout prepass. A merged
   * connected balloon can contain typography outside the compact OCR box.
   */
  ownedRegionMask?: InpaintingWindowMask;
  page: MangaPage;
  segmentation: KoharuTypographySegmentation;
  sourceRect: PixelRect;
  width: number;
}): KoharuTypographyCompositeMask | null {
  assertMatchingImageSize(options);
  const associationRect = expandRect(
    options.sourceRect,
    options.width,
    options.height,
    Math.max(12, resolvePatternBlockMarginPx(options.block, options.page)),
  );
  const detections = options.segmentation.detections.filter(
    (detection) =>
      (detection.label === "text" || detection.label === "onomatopoeia") &&
      detection.mask &&
      (boxesAssociate(detection.box, associationRect, options.sourceRect) ||
        (options.ownedRegionMask !== undefined &&
          boxCenterBelongsToOwnedRegion(
            detection.box,
            options.ownedRegionMask,
          ))),
  );
  if (detections.length === 0) return null;

  const rawBounds = detections
    .map((detection) => clampDetectionBox(detection.box, options))
    .filter((bounds): bounds is PixelRect => bounds !== null)
    .reduce<PixelRect | null>(unionOptionalRect, null);
  if (!rawBounds) return null;

  const coreDilationPx = resolveKoharuTypographyCoreDilationPx(
    options.block,
    options.page,
  );
  const featherPx = Math.max(0, Math.round(options.featherPx));
  const bounds = expandRect(
    rawBounds,
    options.width,
    options.height,
    coreDilationPx + featherPx + 2,
  );
  const raw = new Uint8Array(bounds.w * bounds.h);
  for (const detection of detections) {
    const mask = detection.mask;
    if (!mask) continue;
    rasterizeInstanceMaskInto(raw, bounds, detection.box, mask, options);
  }
  if (!raw.some(Boolean)) return null;

  const core = dilateBinaryMaskDisk(raw, bounds.w, bounds.h, coreDilationPx);
  const featherEnvelope = dilateBinaryMaskDisk(
    core,
    bounds.w,
    bounds.h,
    featherPx,
  );
  return {
    core: trimWindowMask({ bounds, data: core }),
    featherEnvelope: trimWindowMask({ bounds, data: featherEnvelope }),
    detectionCount: detections.length,
    coreDilationPx,
  };
}

export function resolveKoharuTypographyCoreDilationPx(
  block: TranslationBlock,
  page: Pick<MangaPage, "width" | "height">,
): number {
  const fontSizePx = Math.max(1, block.fontSizePx || 20);
  const outlineWidthPx = resolveEffectiveTextOutlineWidthPx(block, fontSizePx);
  const shortEdge = Math.max(1, Math.min(page.width, page.height));
  const pageScale = resolvePageScale(page);
  return clampInteger(
    Math.ceil(
      Math.max(
        shortEdge * 0.007,
        fontSizePx * 0.18,
        outlineWidthPx * 2.25 + 3 * pageScale,
      ),
    ),
    3,
    Math.max(10, Math.round(shortEdge * 0.025)),
  );
}

/** Roughly 1.2% of the page's short edge outside the already-thick core. */
export function resolveKoharuTypographyFeatherPx(
  block: TranslationBlock,
  page: Pick<MangaPage, "width" | "height">,
): number {
  const shortEdge = Math.max(1, Math.min(page.width, page.height));
  return clampInteger(
    Math.ceil(Math.max(shortEdge * 0.012, block.fontSizePx * 0.25)),
    3,
    Math.max(12, Math.round(shortEdge * 0.035)),
  );
}

function resolvePageScale(page: Pick<MangaPage, "width" | "height">): number {
  return Math.max(0.25, Math.min(page.width, page.height) / 1000);
}

export function unionWindowMasks(
  left: InpaintingWindowMask,
  right: InpaintingWindowMask,
): InpaintingWindowMask {
  const bounds = unionRects(left.bounds, right.bounds);
  const data = projectWindowMask(left, bounds);
  const projectedRight = projectWindowMask(right, bounds);
  for (let index = 0; index < data.length; index += 1) {
    if (projectedRight[index]) data[index] = 1;
  }
  return trimWindowMask({ bounds, data });
}

function boxesAssociate(
  box: readonly [number, number, number, number],
  associationRect: PixelRect,
  sourceRect: PixelRect,
): boolean {
  const detectionRect = boxToRect(box);
  if (!detectionRect) return false;
  const intersection = intersectionArea(detectionRect, associationRect);
  if (intersection <= 0) return false;
  const detectionCenter = {
    x: detectionRect.x + detectionRect.w / 2,
    y: detectionRect.y + detectionRect.h / 2,
  };
  const sourceCenter = {
    x: sourceRect.x + sourceRect.w / 2,
    y: sourceRect.y + sourceRect.h / 2,
  };
  return (
    pointInRect(detectionCenter, associationRect) ||
    pointInRect(sourceCenter, detectionRect) ||
    intersection / Math.max(1, detectionRect.w * detectionRect.h) >= 0.08 ||
    intersection / Math.max(1, sourceRect.w * sourceRect.h) >= 0.08
  );
}

function boxCenterBelongsToOwnedRegion(
  box: readonly [number, number, number, number],
  ownedRegion: InpaintingWindowMask,
): boolean {
  const detectionRect = boxToRect(box);
  return (
    detectionRect !== null &&
    readWindowMaskPixel(
      ownedRegion,
      Math.floor(detectionRect.x + detectionRect.w / 2),
      Math.floor(detectionRect.y + detectionRect.h / 2),
    ) > 0
  );
}

function readWindowMaskPixel(
  mask: InpaintingWindowMask,
  pageX: number,
  pageY: number,
): number {
  const localX = pageX - mask.bounds.x;
  const localY = pageY - mask.bounds.y;
  if (
    localX < 0 ||
    localY < 0 ||
    localX >= mask.bounds.w ||
    localY >= mask.bounds.h
  ) {
    return 0;
  }
  return mask.data[localY * mask.bounds.w + localX] ?? 0;
}

function rasterizeInstanceMaskInto(
  output: Uint8Array,
  bounds: PixelRect,
  detectionBox: readonly [number, number, number, number],
  mask: NonNullable<KoharuTypographySegmentation["detections"][number]["mask"]>,
  imageSize: { width: number; height: number },
): void {
  const detectionBounds = boxToRect(detectionBox);
  if (!detectionBounds) return;
  const sampleBounds = expandRect(
    detectionBounds,
    imageSize.width,
    imageSize.height,
    2,
  );
  const left = Math.max(bounds.x, sampleBounds.x);
  const top = Math.max(bounds.y, sampleBounds.y);
  const right = Math.min(bounds.x + bounds.w, sampleBounds.x + sampleBounds.w);
  const bottom = Math.min(bounds.y + bounds.h, sampleBounds.y + sampleBounds.h);
  for (let y = top; y < bottom; y += 1) {
    const maskY = ((y + 0.5) / imageSize.height) * mask.height - 0.5;
    for (let x = left; x < right; x += 1) {
      const maskX = ((x + 0.5) / imageSize.width) * mask.width - 0.5;
      if (bilinearSample(mask, maskX, maskY) >= 0) {
        output[(y - bounds.y) * bounds.w + x - bounds.x] = 1;
      }
    }
  }
}

function bilinearSample(
  mask: NonNullable<KoharuTypographySegmentation["detections"][number]["mask"]>,
  sourceX: number,
  sourceY: number,
): number {
  const floorX = Math.floor(sourceX);
  const floorY = Math.floor(sourceY);
  const left = clampInteger(floorX, 0, mask.width - 1);
  const top = clampInteger(floorY, 0, mask.height - 1);
  const right = Math.min(mask.width - 1, left + 1);
  const bottom = Math.min(mask.height - 1, top + 1);
  const fractionX = clamp(sourceX - floorX, 0, 1);
  const fractionY = clamp(sourceY - floorY, 0, 1);
  const topValue =
    (mask.logits[top * mask.width + left] ?? 0) * (1 - fractionX) +
    (mask.logits[top * mask.width + right] ?? 0) * fractionX;
  const bottomValue =
    (mask.logits[bottom * mask.width + left] ?? 0) * (1 - fractionX) +
    (mask.logits[bottom * mask.width + right] ?? 0) * fractionX;
  return topValue * (1 - fractionY) + bottomValue * fractionY;
}

function trimWindowMask(mask: InpaintingWindowMask): InpaintingWindowMask {
  const { bounds, data } = mask;
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
  if (right < left || bottom < top) {
    throw new Error("Koharu typography mask unexpectedly became empty.");
  }
  if (
    left === 0 &&
    top === 0 &&
    right === bounds.w - 1 &&
    bottom === bounds.h - 1
  ) {
    return mask;
  }
  const width = right - left + 1;
  const height = bottom - top + 1;
  const trimmed = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = (top + y) * bounds.w + left;
    trimmed.set(data.subarray(sourceStart, sourceStart + width), y * width);
  }
  return {
    bounds: { x: bounds.x + left, y: bounds.y + top, w: width, h: height },
    data: trimmed,
  };
}

function assertMatchingImageSize(options: {
  segmentation: KoharuTypographySegmentation;
  width: number;
  height: number;
}): void {
  if (
    options.segmentation.imageWidth !== options.width ||
    options.segmentation.imageHeight !== options.height
  ) {
    throw new Error("Koharu typography segmentation image size drifted.");
  }
}

function clampDetectionBox(
  box: readonly [number, number, number, number],
  imageSize: { width: number; height: number },
): PixelRect | null {
  const rect = boxToRect(box);
  if (!rect) return null;
  const x = clampInteger(rect.x, 0, Math.max(0, imageSize.width - 1));
  const y = clampInteger(rect.y, 0, Math.max(0, imageSize.height - 1));
  const right = clampInteger(rect.x + rect.w, x + 1, imageSize.width);
  const bottom = clampInteger(rect.y + rect.h, y + 1, imageSize.height);
  return { x, y, w: right - x, h: bottom - y };
}

function boxToRect(
  box: readonly [number, number, number, number],
): PixelRect | null {
  if (!box.every(Number.isFinite)) return null;
  const x = Math.floor(box[0]);
  const y = Math.floor(box[1]);
  const right = Math.ceil(box[2]);
  const bottom = Math.ceil(box[3]);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

function unionOptionalRect(
  current: PixelRect | null,
  next: PixelRect,
): PixelRect {
  return current ? unionRects(current, next) : next;
}

function unionRects(left: PixelRect, right: PixelRect): PixelRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.w, right.x + right.w);
  const bottomEdge = Math.max(left.y + left.h, right.y + right.h);
  return { x, y, w: rightEdge - x, h: bottomEdge - y };
}

function intersectionArea(left: PixelRect, right: PixelRect): number {
  return (
    Math.max(
      0,
      Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x),
    ) *
    Math.max(
      0,
      Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y),
    )
  );
}

function pointInRect(
  point: { x: number; y: number },
  rect: PixelRect,
): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.w &&
    point.y < rect.y + rect.h
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
