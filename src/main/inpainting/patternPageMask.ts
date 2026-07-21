import type { MangaPage } from "../../shared/libraryTypes";
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
  otsuBlocks: number;
};

export function buildPatternPageMask(options: {
  page: MangaPage;
  bitmap: Buffer;
  width: number;
  height: number;
  signal?: AbortSignal;
}): PatternMaskContext {
  const context: PatternMaskContext = {
    pageMask: new Uint8Array(options.width * options.height),
    inpaintWindows: [],
    inpaintWindowMasks: [],
    blocksErased: 0,
    otsuBlocks: 0,
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
  if (detected.count > 0) {
    return {
      usedOtsu: detected.strategy === "otsu",
      windowMask: { bounds: detectRect, data: detected.mask },
    };
  }
  return {
    usedOtsu: false,
    windowMask: createFilledWindowMask(
      expandRect(options.sourceRect, options.width, options.height, 2),
    ),
  };
}

type PatternMaskDetectionResult = {
  usedOtsu: boolean;
  windowMask: InpaintingWindowMask;
};

function createFilledWindowMask(bounds: PixelRect): InpaintingWindowMask {
  return {
    bounds,
    data: new Uint8Array(bounds.w * bounds.h).fill(1),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
