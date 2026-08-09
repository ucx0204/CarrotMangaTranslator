import type { MangaPage } from "../../shared/libraryTypes";
import {
  bboxToPixelRect,
  expandRect,
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
import { isPatternInpaintingBlockEligible } from "./patternBlockEligibility";
import { buildPatternTextMask } from "./patternTextMask";
import { extendSharedBubbleMaskWithDetectedText } from "./sharedBubbleTextBridge";

export type PatternPageMaskMode = "glyph" | "flux-region";

export type PatternMaskContext = {
  pageMask: Uint8Array;
  inpaintWindows: PixelRect[];
  inpaintWindowMasks: InpaintingWindowMask[];
  inpaintWindowConstraints: Array<InpaintingWindowMask | null>;
  inpaintWindowGroupIds: string[][];
  validationWindowMasks: InpaintingWindowMask[];
  validationBlockIds: string[];
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
  excludedBlockIds?: readonly string[];
  sharedInpaintGroupIdsByBlock?: Readonly<Record<string, readonly string[]>>;
  signal?: AbortSignal;
}): PatternMaskContext {
  const context: PatternMaskContext = {
    pageMask: new Uint8Array(options.width * options.height),
    inpaintWindows: [],
    inpaintWindowMasks: [],
    inpaintWindowConstraints: [],
    inpaintWindowGroupIds: [],
    validationWindowMasks: [],
    validationBlockIds: [],
    blocksErased: 0,
    otsuBlocks: 0,
  };
  for (const block of options.page.blocks) {
    if (
      !isPatternInpaintingBlockEligible(
        block,
        options.blockId,
        options.excludedBlockIds,
      )
    ) {
      continue;
    }
    throwIfAborted(options.signal);
    mergePatternBlock(options, context, block);
  }
  if (options.mode === "flux-region") {
    coalesceSharedConstrainedWindows(context);
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
  context.validationWindowMasks.push(detection.windowMask);
  context.validationBlockIds.push(block.id);
  context.inpaintWindowConstraints.push(null);
  context.inpaintWindowGroupIds.push([]);
  if (detection.usedOtsu) context.otsuBlocks += 1;
  context.blocksErased += 1;
}

function mergeFluxRegionMask(
  options: Parameters<typeof buildPatternPageMask>[0],
  context: PatternMaskContext,
  block: MangaPage["blocks"][number],
  supportRect: PixelRect,
): void {
  const sharedGroupIds = [
    ...(options.sharedInpaintGroupIdsByBlock?.[block.id] ?? []),
  ];
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
  const { regionMask, usedOtsu } = resolveFluxRegionMask({
    options,
    block,
    supportRect,
    bubbleMask,
    shared: sharedGroupIds.length > 0,
  });
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
  context.validationWindowMasks.push(regionMask);
  context.validationBlockIds.push(block.id);
  // Only a detected green region is a hard final-composite boundary. The
  // no-green fallback intentionally preserves the legacy OCR-region feather.
  context.inpaintWindowConstraints.push(bubbleMask ? regionMask : null);
  context.inpaintWindowGroupIds.push(bubbleMask ? sharedGroupIds : []);
  if (usedOtsu) context.otsuBlocks += 1;
  context.blocksErased += 1;
}

function resolveFluxRegionMask({
  options,
  block,
  supportRect,
  bubbleMask,
  shared,
}: {
  options: Parameters<typeof buildPatternPageMask>[0];
  block: MangaPage["blocks"][number];
  supportRect: PixelRect;
  bubbleMask: InpaintingWindowMask | null;
  shared: boolean;
}): { regionMask: InpaintingWindowMask; usedOtsu: boolean } {
  const detectionOptions = {
    ...options,
    block,
    sourceRect: bboxToPixelRect(block.bbox, options.page),
  };
  if (!bubbleMask) {
    const detection = mergePatternDetectionMask(detectionOptions);
    return {
      regionMask: mergeLegacyFluxRegionMask(supportRect, detection.windowMask),
      usedOtsu: detection.usedOtsu,
    };
  }
  const detectedMask = shared
    ? detectPatternTextWindowMask(detectionOptions)?.windowMask
    : undefined;
  return {
    regionMask: extendSharedBubbleMaskWithDetectedText(
      bubbleMask,
      detectedMask,
      supportRect,
      resolveSharedBubbleTextBridgeRadius(block, options.page),
    ),
    usedOtsu: false,
  };
}

function mergePatternDetectionMask(options: {
  page: MangaPage;
  block: MangaPage["blocks"][number];
  bitmap: Buffer;
  width: number;
  height: number;
  sourceRect: PixelRect;
}): PatternMaskDetectionResult {
  const detected = detectPatternTextWindowMask(options);
  if (detected) return detected;
  return {
    usedOtsu: false,
    windowMask: createFilledWindowMask(
      expandRect(options.sourceRect, options.width, options.height, 2),
    ),
  };
}

function detectPatternTextWindowMask(options: {
  page: MangaPage;
  block: MangaPage["blocks"][number];
  bitmap: Buffer;
  width: number;
  height: number;
  sourceRect: PixelRect;
}): PatternMaskDetectionResult | null {
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
  return null;
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

function resolveSharedBubbleTextBridgeRadius(
  block: MangaPage["blocks"][number],
  page: MangaPage,
): number {
  return Math.max(
    resolvePatternDilationRadius(block) + 2,
    resolvePatternRegionPaddingPx(block, page),
  );
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

function coalesceSharedConstrainedWindows(context: PatternMaskContext): void {
  const roots = resolveSharedWindowRoots(context.inpaintWindowGroupIds);
  const windows: PixelRect[] = [];
  const masks: InpaintingWindowMask[] = [];
  const constraints: Array<InpaintingWindowMask | null> = [];
  const groupIds: string[][] = [];
  const outputIndexByRoot = new Map<number, number>();
  for (let index = 0; index < context.inpaintWindows.length; index += 1) {
    const window = context.inpaintWindows[index];
    const mask = context.inpaintWindowMasks[index];
    const constraint = context.inpaintWindowConstraints[index] ?? null;
    if (!window || !mask) {
      throw new Error("Inpainting window metadata is incomplete.");
    }
    const root = roots[index] ?? index;
    const outputIndex = outputIndexByRoot.get(root);
    if (outputIndex === undefined) {
      outputIndexByRoot.set(root, windows.length);
      windows.push(window);
      masks.push(mask);
      constraints.push(constraint);
      groupIds.push([...(context.inpaintWindowGroupIds[index] ?? [])]);
      continue;
    }
    const existingWindow = windows[outputIndex] as PixelRect;
    const existingMask = masks[outputIndex] as InpaintingWindowMask;
    windows[outputIndex] = unionRects(existingWindow, window);
    masks[outputIndex] = unionWindowMasks(existingMask, mask);
    constraints[outputIndex] = unionOptionalWindowMasks(
      constraints[outputIndex] ?? null,
      constraint,
    );
    groupIds[outputIndex] = [
      ...new Set([
        ...(groupIds[outputIndex] ?? []),
        ...(context.inpaintWindowGroupIds[index] ?? []),
      ]),
    ];
  }
  context.inpaintWindows = windows;
  context.inpaintWindowMasks = masks;
  context.inpaintWindowConstraints = constraints;
  context.inpaintWindowGroupIds = groupIds;
}

function resolveSharedWindowRoots(groupIds: readonly string[][]): number[] {
  const parents = groupIds.map((_, index) => index);
  const firstWindowByGroup = new Map<string, number>();
  for (const [index, ids] of groupIds.entries()) {
    for (const id of ids) {
      const firstIndex = firstWindowByGroup.get(id);
      if (firstIndex === undefined) {
        firstWindowByGroup.set(id, index);
      } else {
        joinWindowRoots(parents, firstIndex, index);
      }
    }
  }
  return parents.map((_, index) => findWindowRoot(parents, index));
}

function findWindowRoot(parents: number[], index: number): number {
  let root = index;
  while (parents[root] !== root) root = parents[root] as number;
  let cursor = index;
  while (parents[cursor] !== cursor) {
    const parent = parents[cursor] as number;
    parents[cursor] = root;
    cursor = parent;
  }
  return root;
}

function joinWindowRoots(parents: number[], left: number, right: number): void {
  const leftRoot = findWindowRoot(parents, left);
  const rightRoot = findWindowRoot(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}

function unionOptionalWindowMasks(
  left: InpaintingWindowMask | null,
  right: InpaintingWindowMask | null,
): InpaintingWindowMask | null {
  if (!left) return right;
  if (!right) return left;
  return unionWindowMasks(left, right);
}

function unionWindowMasks(
  left: InpaintingWindowMask,
  right: InpaintingWindowMask,
): InpaintingWindowMask {
  const bounds = unionRects(left.bounds, right.bounds);
  const data = projectWindowMask(left, bounds);
  mergeLocalMask(data, projectWindowMask(right, bounds));
  return { bounds, data };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
