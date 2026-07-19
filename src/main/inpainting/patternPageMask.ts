import type { MangaPage } from "../../shared/libraryTypes";
import {
  buildBubbleConstraintMask,
  resolveBubbleIdForRect,
} from "./bubbleMaskDetection";
import {
  applyFlatBubbleFill,
  resolveFlatBubbleFill,
} from "./hybridBubbleCleaning";
import {
  bboxToPixelRect,
  expandRect,
  hasUsableBbox,
  mergeFilledRectIntoPage,
  mergeMaskIntoPage,
  resolvePatternBlockMarginPx,
  resolvePatternDilationRadius,
  resolvePatternRegionPaddingPx,
  resolvePatternWindowMarginPx,
  type PixelRect,
} from "./maskGeometry";
import { buildPatternTextMask } from "./patternTextMask";

export type PatternMaskContext = {
  pageMask: Uint8Array;
  inpaintWindows: PixelRect[];
  blocksErased: number;
  engineBlocks: number;
  otsuBlocks: number;
  directFillBlocks: number;
};

export function buildPatternPageMask(options: {
  page: MangaPage;
  bitmap: Buffer;
  width: number;
  height: number;
  signal?: AbortSignal;
  bubbleMask: Uint8Array;
}): PatternMaskContext {
  const context: PatternMaskContext = {
    pageMask: new Uint8Array(options.width * options.height),
    inpaintWindows: [],
    blocksErased: 0,
    engineBlocks: 0,
    otsuBlocks: 0,
    directFillBlocks: 0,
  };
  for (const block of options.page.blocks) {
    if (!hasUsableBbox(block.bbox) || block.inpaintExcluded) continue;
    throwIfAborted(options.signal);
    mergePatternBlock(options, context, block);
  }
  return context;
}

function mergePatternBlock(
  options: Parameters<typeof buildPatternPageMask>[0],
  context: PatternMaskContext,
  block: MangaPage["blocks"][number],
): void {
  const sourceRect = bboxToPixelRect(block.bbox, options.page);
  const supportRect = expandRect(
    sourceRect,
    options.width,
    options.height,
    resolvePatternRegionPaddingPx(block, options.page),
  );
  const detection = mergePatternDetectionMask({
    ...options,
    block,
    sourceRect,
    pageMask: context.pageMask,
  });
  if (detection.directFilled) {
    context.directFillBlocks += 1;
  } else {
    context.inpaintWindows.push(
      expandRect(
        supportRect,
        options.width,
        options.height,
        resolvePatternWindowMarginPx(block, options.page),
      ),
    );
    context.engineBlocks += 1;
  }
  if (detection.usedOtsu) context.otsuBlocks += 1;
  context.blocksErased += 1;
}

function mergePatternDetectionMask(options: {
  page: MangaPage;
  block: MangaPage["blocks"][number];
  bitmap: Buffer;
  width: number;
  height: number;
  sourceRect: PixelRect;
  pageMask: Uint8Array;
  bubbleMask: Uint8Array;
}): { directFilled: boolean; usedOtsu: boolean } {
  const detectRect = expandRect(
    options.sourceRect,
    options.width,
    options.height,
    resolvePatternBlockMarginPx(options.block, options.page),
  );
  const detected = buildPatternTextMask(
    options.bitmap,
    options.width,
    options.height,
    detectRect,
    resolvePatternDilationRadius(options.block),
    { focusRect: options.sourceRect },
  );
  const bubbleId = resolveBubbleIdForRect(
    options.bubbleMask,
    options.width,
    options.sourceRect,
  );
  const constraintMask = buildBubbleConstraintMask(
    options.bubbleMask,
    options.width,
    options.height,
    detectRect,
    bubbleId,
  );
  const constrainedMask = intersectMasksIfUseful(detected.mask, constraintMask);
  if (detected.count > 0) {
    return mergeDetectedPatternMask({
      ...options,
      constrainedMask,
      constraintMask,
      detectRect,
      strategy: detected.strategy,
    });
  }
  mergePatternFallbackMask({ ...options, constraintMask, detectRect });
  return { directFilled: false, usedOtsu: false };
}

function mergeDetectedPatternMask(options: {
  bitmap: Buffer;
  constrainedMask: Uint8Array;
  constraintMask: Uint8Array;
  detectRect: PixelRect;
  pageMask: Uint8Array;
  strategy: "adaptive" | "otsu" | "none";
  width: number;
}): { directFilled: boolean; usedOtsu: boolean } {
  const fill = resolveFlatBubbleFill(
    options.bitmap,
    options.width,
    options.detectRect,
    options.constrainedMask,
    hasMaskPixels(options.constraintMask) ? options.constraintMask : undefined,
  );
  if (fill) {
    applyFlatBubbleFill(
      options.bitmap,
      options.width,
      options.detectRect,
      options.constrainedMask,
      fill.color,
    );
  } else {
    mergeMaskIntoPage(
      options.pageMask,
      options.width,
      options.detectRect,
      options.constrainedMask,
    );
  }
  return { directFilled: Boolean(fill), usedOtsu: options.strategy === "otsu" };
}

function mergePatternFallbackMask(options: {
  constraintMask: Uint8Array;
  detectRect: PixelRect;
  height: number;
  pageMask: Uint8Array;
  sourceRect: PixelRect;
  width: number;
}): void {
  const fallbackRect = expandRect(
    options.sourceRect,
    options.width,
    options.height,
    2,
  );
  if (!hasMaskPixels(options.constraintMask)) {
    mergeFilledRectIntoPage(options.pageMask, options.width, fallbackRect);
    return;
  }
  const fallbackMask = restrictMaskToPageRect(
    options.constraintMask,
    options.detectRect,
    fallbackRect,
  );
  if (hasMaskPixels(fallbackMask)) {
    mergeMaskIntoPage(
      options.pageMask,
      options.width,
      options.detectRect,
      fallbackMask,
    );
  } else {
    mergeFilledRectIntoPage(options.pageMask, options.width, fallbackRect);
  }
}

function intersectMasksIfUseful(
  mask: Uint8Array,
  constraint: Uint8Array,
): Uint8Array {
  if (!hasMaskPixels(constraint)) return mask;
  const output = new Uint8Array(mask.length);
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] && constraint[index]) {
      output[index] = 1;
      count += 1;
    }
  }
  return count > 0 ? output : mask;
}

function hasMaskPixels(mask: Uint8Array): boolean {
  return mask.some((value) => value !== 0);
}

function restrictMaskToPageRect(
  mask: Uint8Array,
  maskRect: PixelRect,
  allowedRect: PixelRect,
): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < maskRect.h; y += 1) {
    for (let x = 0; x < maskRect.w; x += 1) {
      const pageX = maskRect.x + x;
      const pageY = maskRect.y + y;
      if (
        pageX >= allowedRect.x &&
        pageX < allowedRect.x + allowedRect.w &&
        pageY >= allowedRect.y &&
        pageY < allowedRect.y + allowedRect.h
      ) {
        output[y * maskRect.w + x] = mask[y * maskRect.w + x] ?? 0;
      }
    }
  }
  return output;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
