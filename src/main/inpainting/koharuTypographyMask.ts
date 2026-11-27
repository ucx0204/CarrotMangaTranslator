import { bboxOverlapRatio } from "../../shared/geometry";
import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import { resolveEffectiveTextOutlineWidthPx } from "../../shared/textOutline";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import {
  expandRect,
  pointInRect,
  resolvePatternBlockMarginPx,
  unionRects,
  type PixelRect,
} from "./maskGeometry";
import { dilateBinaryMaskDisk } from "./patternMaskMorphology";
import { maskBoundsInRect } from "./imageRaster";

export type MeasuredBrush = boolean | "solid-impact";
export type KoharuTypographyCompositeMask = {
  measuredBrush?: MeasuredBrush;
  instance: InpaintingWindowMask;
  core: InpaintingWindowMask;
  featherEnvelope: InpaintingWindowMask;
  detectionCount: number;
  coreDilationPx: number;
};

type TypographyMaskOptions = {
  block: TranslationBlock;
  /** Explicit source-mask policy; omitted preserves the production Flux geometry. */
  coreDilationPx?: number;
  featherPx: number;
  height: number;
  /**
   * Block-owned bubble region from the transient layout prepass. A merged
   * connected balloon can contain typography outside the compact OCR box.
   */
  ownedRegionMask?: InpaintingWindowMask;
  /** For free-standing Qwen lettering a box intersection must contain actual ink. */
  requireInkInSourceRect?: boolean;
  completeOutline?: (
    instance: InpaintingWindowMask,
    detections: KoharuTypographySegmentation["detections"],
  ) =>
    | (InpaintingWindowMask & {
        measuredBrush?: MeasuredBrush;
        compositeOutline?: InpaintingWindowMask;
      })
    | undefined;
  page: MangaPage;
  segmentation: KoharuTypographySegmentation;
  sourceRect: PixelRect;
  width: number;
};

/**
 * Converts Koharu text/SFX instance masks into a fully opaque erase core plus
 * an outer envelope used only by Flux's distance feather. The detector's raw
 * mask is deliberately thickened before feathering so outlined source glyphs
 * cannot survive as a bright fringe.
 */
export function buildKoharuTypographyCompositeMask(
  options: TypographyMaskOptions,
): KoharuTypographyCompositeMask | null {
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
          ))) &&
      selectedInkMatches(detection, options),
  );
  if (detections.length === 0) return null;

  const rawBounds = detections
    .map((detection) => clampDetectionBox(detection.box, options))
    .filter((bounds): bounds is PixelRect => bounds !== null)
    .reduce<PixelRect | null>(
      (bounds, next) => (bounds ? unionRects(bounds, next) : next),
      null,
    );
  if (!rawBounds) return null;

  const coreDilationPx =
    options.coreDilationPx ??
    resolveKoharuTypographyCoreDilationPx(options.block, options.page);
  const featherPx = Math.max(0, Math.round(options.featherPx));
  const padding = coreDilationPx + featherPx + 2;
  const { width, height } = options;
  const bounds = expandRect(rawBounds, width, height, padding);
  const raw = new Uint8Array(bounds.w * bounds.h);
  for (const detection of detections) {
    const mask = detection.mask;
    if (!mask) continue;
    rasterizeInstanceMaskInto(
      raw,
      bounds,
      detection.box,
      mask,
      options,
      options.ownedRegionMask ? undefined : associationRect,
    );
  }
  if (!raw.some(Boolean)) return null;
  const raster = { bounds, data: raw };
  const outline = options.completeOutline?.(trimWindowMask(raster), detections);
  if (outline?.measuredBrush) {
    const core = trimWindowMask(outline.compositeOutline ?? outline);
    return {
      instance: trimWindowMask(outline),
      core,
      featherEnvelope: core,
      detectionCount: detections.length,
      coreDilationPx: 0,
      measuredBrush: outline.measuredBrush,
    };
  }
  const completed = paddedOutline(raster, outline, options, padding);
  return dilateTypographyInstance(
    completed,
    coreDilationPx,
    featherPx,
    detections.length,
  );
}

function paddedOutline(
  raster: InpaintingWindowMask,
  outline: InpaintingWindowMask | undefined,
  size: { width: number; height: number },
  padding: number,
) {
  if (!outline) return raster;
  const complete = unionWindowMasks(raster, outline);
  const bounds = expandRect(complete.bounds, size.width, size.height, padding);
  return { bounds, data: projectWindowMask(complete, bounds) };
}

function selectedInkMatches(
  detection: KoharuTypographySegmentation["detections"][number],
  options: Parameters<typeof buildKoharuTypographyCompositeMask>[0],
) {
  if (!options.requireInkInSourceRect) return true;
  return (
    !!detection.mask &&
    rasterizeInstanceMaskInto(
      undefined,
      options.sourceRect,
      detection.box,
      detection.mask,
      options,
    )
  );
}

function dilateTypographyInstance(
  completed: InpaintingWindowMask,
  coreDilationPx: number,
  featherPx: number,
  detectionCount: number,
): KoharuTypographyCompositeMask {
  const { w, h } = completed.bounds;
  const core = dilateBinaryMaskDisk(completed.data, w, h, coreDilationPx);
  const featherEnvelope = dilateBinaryMaskDisk(core, w, h, featherPx);
  return {
    instance: trimWindowMask(completed),
    core: trimWindowMask({ bounds: completed.bounds, data: core }),
    featherEnvelope: trimWindowMask({
      bounds: completed.bounds,
      data: featherEnvelope,
    }),
    detectionCount,
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
  // Context padding can contain another word. It must not turn that neighbor
  // into the entire erase core when the selected lettering was not detected.
  // Connected balloons retain their explicit owned-region association above.
  const overlap = bboxOverlapRatio(detectionRect, sourceRect);
  if (overlap <= 0) return false;
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
    overlap >= 0.08
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
  output: Uint8Array | undefined,
  bounds: PixelRect,
  detectionBox: readonly [number, number, number, number],
  mask: NonNullable<KoharuTypographySegmentation["detections"][number]["mask"]>,
  imageSize: { width: number; height: number },
  clipRect: PixelRect = { x: 0, y: 0, w: imageSize.width, h: imageSize.height },
): boolean {
  const detectionBounds = boxToRect(detectionBox);
  if (!detectionBounds) return false;
  const sampleBounds = expandRect(
    detectionBounds,
    imageSize.width,
    imageSize.height,
    2,
  );
  // A single detector instance may contain several separate SFX blocks.
  // Only the selected source region may claim it; detected balloon ownership
  // supplies its own hard constraint and may legitimately span two lobes.
  const left = Math.max(bounds.x, sampleBounds.x, clipRect.x);
  const top = Math.max(bounds.y, sampleBounds.y, clipRect.y);
  const right = Math.min(
    bounds.x + bounds.w,
    sampleBounds.x + sampleBounds.w,
    clipRect.x + clipRect.w,
  );
  const bottom = Math.min(
    bounds.y + bounds.h,
    sampleBounds.y + sampleBounds.h,
    clipRect.y + clipRect.h,
  );
  let found = false;
  for (let y = top; y < bottom; y += 1) {
    const maskY = ((y + 0.5) / imageSize.height) * mask.height - 0.5;
    for (let x = left; x < right; x += 1) {
      const maskX = ((x + 0.5) / imageSize.width) * mask.width - 0.5;
      if (!(bilinearSample(mask, maskX, maskY) > 0)) continue;
      if (!output) return true;
      found = true;
      output[(y - bounds.y) * bounds.w + x - bounds.x] = 1;
    }
  }
  return found;
}

/** Sample a detector instance on the same native grid as its composite mask. */
export function nativeKoharuTextInstance(
  detection: KoharuTypographySegmentation["detections"][number],
  size: { width: number; height: number },
  label: "text" | "onomatopoeia" = "text",
): InpaintingWindowMask | undefined {
  if (detection.label !== label || !detection.mask) return;
  const bounds = clampDetectionBox(detection.box, size);
  if (!bounds) return;
  const data = new Uint8Array(bounds.w * bounds.h);
  rasterizeInstanceMaskInto(data, bounds, detection.box, detection.mask, size);
  return { bounds, data };
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

export function trimWindowMask(
  mask: InpaintingWindowMask,
): InpaintingWindowMask {
  const { bounds, data } = mask;
  const active = maskBoundsInRect(data, bounds.w, { ...bounds, x: 0, y: 0 });
  if (!active) {
    throw new Error("Koharu typography mask unexpectedly became empty.");
  }
  const { x: left, y: top, w: width, h: height } = active;
  if (width === bounds.w && height === bounds.h) return mask;
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
