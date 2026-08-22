import type { MangaPage } from "../../shared/libraryTypes";
import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
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
import { coalesceSharedConstrainedWindows } from "./patternSharedWindows";
import {
  buildSourceGlyphEvidence,
  type SourceGlyphEvidence,
} from "./sourceGlyphResidual";
import { FLUX_INPAINT_FEATHER_PX } from "./fluxEngineConstants";
import { resolvePatternFluxCompositePlan } from "./patternFluxCompositePlan";
import {
  createEmptyPatternMaskContext,
  type PatternMaskContext,
} from "./patternMaskContext";

export type { PatternMaskContext } from "./patternMaskContext";

export type PatternPageMaskMode = "glyph" | "flux-region";

export function buildPatternPageMask(options: {
  blockId?: string;
  page: MangaPage;
  bitmap: Buffer;
  /** Immutable decoded original used only for diagnostic source evidence. */
  sourceEvidenceBitmap?: Buffer;
  /** Disabled by production; QA/offline callers opt in explicitly. */
  collectSourceGlyphEvidence?: boolean;
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
  typographySegmentation?: KoharuTypographySegmentation;
  signal?: AbortSignal;
}): PatternMaskContext {
  const context = createEmptyPatternMaskContext(options.width, options.height);
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
  const sourceGlyphEvidence =
    options.collectSourceGlyphEvidence === true
      ? buildSourceGlyphEvidence({
          bitmap: options.sourceEvidenceBitmap ?? options.bitmap,
          block,
          height: options.height,
          page: options.page,
          width: options.width,
        })
      : undefined;
  const supportRect = expandRect(
    sourceRect,
    options.width,
    options.height,
    resolvePatternRegionPaddingPx(block, options.page),
  );
  if (options.mode === "flux-region") {
    mergeFluxRegionMask(
      options,
      context,
      block,
      supportRect,
      sourceGlyphEvidence,
    );
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
  context.inpaintCompositeMasks.push(detection.windowMask);
  context.inpaintCompositeFeatherPx.push(FLUX_INPAINT_FEATHER_PX);
  appendPatternValidationBinding(
    context,
    block.id,
    detection.windowMask,
    sourceGlyphEvidence,
  );
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
  sourceGlyphEvidence: SourceGlyphEvidence | undefined,
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
  const plan = resolvePatternFluxCompositePlan({
    block,
    fallbackConstraint: bubbleMask ? regionMask : null,
    height: options.height,
    page: options.page,
    regionMask,
    segmentation: options.typographySegmentation,
    sourceRect: bboxToPixelRect(block.bbox, options.page),
    width: options.width,
  });
  const { compositeMask, featherPx: compositeFeatherPx, modelMask } = plan;
  context.usesKoharuTypographyComposite ||= plan.usesTypographySegmentation;
  const bounds = modelMask.bounds;
  mergeMaskIntoPage(
    context.pageMask,
    options.width,
    modelMask.bounds,
    modelMask.data,
  );
  context.inpaintWindows.push(
    expandRect(
      bounds,
      options.width,
      options.height,
      resolvePatternWindowMarginPx(block, options.page),
    ),
  );
  context.inpaintWindowMasks.push(modelMask);
  context.inpaintCompositeMasks.push(compositeMask);
  context.inpaintCompositeFeatherPx.push(compositeFeatherPx);
  appendPatternValidationBinding(
    context,
    block.id,
    compositeMask,
    sourceGlyphEvidence,
  );
  // Only a detected green region is a hard final-composite boundary. The
  // no-green fallback intentionally preserves the legacy OCR-region feather.
  context.inpaintWindowConstraints.push(plan.constraint);
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

function appendPatternValidationBinding(
  context: PatternMaskContext,
  blockId: string,
  firstPassCore: InpaintingWindowMask,
  sourceGlyphEvidence: SourceGlyphEvidence | undefined,
): void {
  if (context.validationBlockIds.includes(blockId)) {
    throw new Error(`Duplicate pattern validation block binding: ${blockId}`);
  }
  context.validationBlockIds.push(blockId);
  context.validationWindowMasks.push(firstPassCore);
  if (!sourceGlyphEvidence) return;
  context.sourceGlyphEvidence.push(sourceGlyphEvidence);
  context.validationBindingsByBlockId.set(blockId, {
    blockId,
    firstPassCore,
    sourceGlyphEvidence,
  });
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
