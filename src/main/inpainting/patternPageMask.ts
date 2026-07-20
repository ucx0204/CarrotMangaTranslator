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
  mergeMaskIntoPage,
  resolvePatternBlockMarginPx,
  resolvePatternDilationRadius,
  resolvePatternRegionPaddingPx,
  resolvePatternWindowMarginPx,
  type PixelRect,
} from "./maskGeometry";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { buildPatternTextMask } from "./patternTextMask";

export type PatternMaskContext = {
  pageMask: Uint8Array;
  inpaintWindows: PixelRect[];
  inpaintWindowMasks: InpaintingWindowMask[];
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
    inpaintWindowMasks: [],
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
  });
  if (detection.directFilled) {
    context.directFillBlocks += 1;
  } else {
    if (!detection.windowMask) {
      throw new Error("Pattern mask detection did not return an engine mask.");
    }
    mergeMaskIntoPage(
      context.pageMask,
      options.width,
      detection.windowMask.bounds,
      detection.windowMask.data,
    );
    context.inpaintWindows.push(
      expandRect(
        supportRect,
        options.width,
        options.height,
        resolvePatternWindowMarginPx(block, options.page),
      ),
    );
    context.inpaintWindowMasks.push(detection.windowMask);
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
  bubbleMask: Uint8Array;
}): PatternMaskDetectionResult {
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
  return {
    directFilled: false,
    usedOtsu: false,
    windowMask: buildPatternFallbackMask({
      ...options,
      constraintMask,
      detectRect,
    }),
  };
}

function mergeDetectedPatternMask(options: {
  bitmap: Buffer;
  constrainedMask: Uint8Array;
  constraintMask: Uint8Array;
  detectRect: PixelRect;
  strategy: "adaptive" | "otsu" | "none";
  width: number;
}): PatternMaskDetectionResult {
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
  }
  return {
    directFilled: Boolean(fill),
    usedOtsu: options.strategy === "otsu",
    windowMask: fill
      ? undefined
      : {
          bounds: options.detectRect,
          data: options.constrainedMask,
        },
  };
}

function buildPatternFallbackMask(options: {
  constraintMask: Uint8Array;
  detectRect: PixelRect;
  height: number;
  sourceRect: PixelRect;
  width: number;
}): InpaintingWindowMask {
  const fallbackRect = expandRect(
    options.sourceRect,
    options.width,
    options.height,
    2,
  );
  if (!hasMaskPixels(options.constraintMask)) {
    return createFilledWindowMask(fallbackRect);
  }
  const fallbackMask = restrictMaskToPageRect(
    options.constraintMask,
    options.detectRect,
    fallbackRect,
  );
  if (hasMaskPixels(fallbackMask)) {
    return { bounds: options.detectRect, data: fallbackMask };
  }
  return createFilledWindowMask(fallbackRect);
}

type PatternMaskDetectionResult = {
  directFilled: boolean;
  usedOtsu: boolean;
  windowMask?: InpaintingWindowMask;
};

function createFilledWindowMask(bounds: PixelRect): InpaintingWindowMask {
  return {
    bounds,
    data: new Uint8Array(bounds.w * bounds.h).fill(1),
  };
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
