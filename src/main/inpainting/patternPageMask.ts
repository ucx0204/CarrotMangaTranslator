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
import {
  buildBubbleLayoutConstraintMask,
  projectWindowMask,
} from "./bubbleLayoutConstraintMask";
import { buildPatternTextMask } from "./patternTextMask";

export type PatternPageMaskMode = "glyph" | "flux-region";

export type PatternMaskContext = {
  pageMask: Uint8Array;
  inpaintWindows: PixelRect[];
  inpaintWindowMasks: InpaintingWindowMask[];
  inpaintWindowConstraints: Array<InpaintingWindowMask | null>;
  blocksErased: number;
  otsuBlocks: number;
};

export function buildPatternPageMask(options: {
  blockId?: string;
  page: MangaPage;
  bitmap: Buffer;
  width: number;
  height: number;
  mode?: PatternPageMaskMode;
  /**
   * Only a job-local, zero-padding bubble prepass may enable this. Persisted
   * layout geometry can include user-configured text padding and is not an
   * inpainting boundary.
   */
  bubbleLayoutConstraintBlockIds?: readonly string[];
  signal?: AbortSignal;
}): PatternMaskContext {
  const context: PatternMaskContext = {
    pageMask: new Uint8Array(options.width * options.height),
    inpaintWindows: [],
    inpaintWindowMasks: [],
    inpaintWindowConstraints: [],
    blocksErased: 0,
    otsuBlocks: 0,
  };
  for (const block of options.page.blocks) {
    if (options.blockId && block.id !== options.blockId) continue;
    if (
      !hasUsableBbox(block.bbox) ||
      (block.inpaintExcluded && block.id !== options.blockId)
    ) {
      continue;
    }
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
  if (options.mode === "flux-region") {
    mergeFluxRegionMask(options, context, block, supportRect);
    return;
  }
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
  context.inpaintWindowConstraints.push(null);
  if (detection.usedOtsu) context.otsuBlocks += 1;
  context.blocksErased += 1;
}

function mergeFluxRegionMask(
  options: Parameters<typeof buildPatternPageMask>[0],
  context: PatternMaskContext,
  block: MangaPage["blocks"][number],
  supportRect: PixelRect,
): void {
  const bubbleMask = options.bubbleLayoutConstraintBlockIds?.includes(block.id)
    ? buildBubbleLayoutConstraintMask(
        block,
        options.page,
        options.width,
        options.height,
      )
    : null;
  // A usable green region is authoritative. Do not union the OCR rectangle:
  // on connected balloons an oversized OCR box can cross into its neighbor.
  const legacyDetection = bubbleMask
    ? null
    : mergePatternDetectionMask({
        ...options,
        block,
        sourceRect: bboxToPixelRect(block.bbox, options.page),
      });
  const regionMask =
    bubbleMask ??
    mergeLegacyFluxRegionMask(supportRect, legacyDetection?.windowMask);
  const bounds = regionMask.bounds;
  mergeMaskIntoPage(
    context.pageMask,
    options.width,
    regionMask.bounds,
    regionMask.data,
  );
  context.inpaintWindows.push(
    expandRect(
      bounds,
      options.width,
      options.height,
      resolvePatternWindowMarginPx(block, options.page),
    ),
  );
  context.inpaintWindowMasks.push(regionMask);
  // Only a detected green region is a hard final-composite boundary. The
  // no-green fallback intentionally preserves the legacy OCR-region feather.
  context.inpaintWindowConstraints.push(bubbleMask ? regionMask : null);
  if (legacyDetection?.usedOtsu) context.otsuBlocks += 1;
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

function mergeLegacyFluxRegionMask(
  supportRect: PixelRect,
  detectedMask: InpaintingWindowMask | undefined,
): InpaintingWindowMask {
  if (!detectedMask) return createFilledWindowMask(supportRect);
  const bounds = unionRects(supportRect, detectedMask.bounds);
  const data = new Uint8Array(bounds.w * bounds.h);
  fillRectInWindowMask(data, bounds, supportRect);
  mergeLocalMask(data, projectWindowMask(detectedMask, bounds));
  return { bounds, data };
}

function fillRectInWindowMask(
  mask: Uint8Array,
  bounds: PixelRect,
  rect: PixelRect,
): void {
  const left = Math.max(bounds.x, rect.x);
  const top = Math.max(bounds.y, rect.y);
  const right = Math.min(bounds.x + bounds.w, rect.x + rect.w);
  const bottom = Math.min(bounds.y + bounds.h, rect.y + rect.h);
  for (let y = top; y < bottom; y += 1) {
    const start = (y - bounds.y) * bounds.w + left - bounds.x;
    mask.fill(1, start, start + right - left);
  }
}

function mergeLocalMask(target: Uint8Array, source: Uint8Array): void {
  for (let index = 0; index < target.length; index += 1) {
    if (source[index]) target[index] = 1;
  }
}

function unionRects(left: PixelRect, right: PixelRect): PixelRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.w, right.x + right.w);
  const bottomEdge = Math.max(left.y + left.h, right.y + right.h);
  return { x, y, w: rightEdge - x, h: bottomEdge - y };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
