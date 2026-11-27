import type { MangaPage } from "../../shared/libraryTypes";
import { createAbortError } from "../abortSignal";
import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import {
  bboxToPixelRect,
  expandRect,
  mergeMaskIntoPage,
  resolvePatternBlockMarginPx,
  resolvePatternDilationRadius,
  resolvePatternRegionPaddingPx,
  resolvePatternWindowMarginPx,
  unionRects,
  type PixelRect,
} from "./maskGeometry";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import {
  resolveEligiblePatternBlocks,
  resolveFluxBubbleConstraint,
  sharedTypographyOwnership,
  protectUnselectedFluxPlan,
} from "./patternBlockEligibility";
import { buildPatternTextMask } from "./patternTextMask";
import { extendSharedBubbleMaskWithDetectedText } from "./sharedBubbleTextBridge";
import { prepareGroupedRegionWindows } from "./patternSharedWindows";
import {
  buildSourceGlyphEvidence,
  type SourceGlyphEvidence,
} from "./sourceGlyphResidual";
import { FLUX_INPAINT_FEATHER_PX } from "./fluxEngineConstants";
import { resolvePatternFluxCompositePlan } from "./patternFluxCompositePlan";
import {
  pairQwenTitleWindows,
  type QwenRuledTitleBand,
} from "./qwenRuledTitle";
import { selectedPrintGroups } from "./qwenIllustratedPlate";
import { QwenRepeatedGlyphs } from "./qwenRepeatedGlyphs";
import {
  appendPatternValidationBinding,
  collectPaperGradient,
  finalizeMeasuredPaper,
  createEmptyPatternMaskContext,
  type PatternMaskContext,
} from "./patternMaskContext";

export type { PatternMaskContext } from "./patternMaskContext";

export type PatternPageMaskMode = "glyph" | "flux-region" | "codex-region";

export function buildPatternPageMask(options: {
  blockId?: string;
  blockIds?: readonly string[];
  page: MangaPage;
  bitmap: Buffer;
  /** Immutable decoded original used only for diagnostic source evidence. */
  sourceEvidenceBitmap?: Buffer;
  /** Disabled by production; QA/offline callers opt in explicitly. */
  collectSourceGlyphEvidence?: boolean;
  width: number;
  height: number;
  mode?: PatternPageMaskMode;
  conditionOnTypography?: boolean;
  /**
   * Only a job-local, zero-padding bubble prepass may enable this. Persisted
   * layout geometry can include user-configured text padding and is not an
   * inpainting boundary.
   */
  bubbleLayoutConstraintBlockIds?: readonly string[];
  excludedBlockIds?: readonly string[];
  sharedInpaintGroupIdsByBlock?: Readonly<Record<string, readonly string[]>>;
  typographySegmentation?: KoharuTypographySegmentation;
  sourceEraseConstraintsByBlock?: Readonly<
    Record<string, InpaintingWindowMask>
  >;
  signal?: AbortSignal;
}): PatternMaskContext {
  const context = createEmptyPatternMaskContext(options.width, options.height);
  const eligible = resolveEligiblePatternBlocks(
    options.page,
    options.blockId,
    options.excludedBlockIds,
    options.blockIds,
  );
  const working = {
    ...options,
    selectedDialogue: options.conditionOnTypography
      ? new Set(
          eligible
            .filter((b) => b.textRole !== "sound" && b.sourceText.trim())
            .map((b) => b.id),
        )
      : undefined,
    repeatedGlyphs: QwenRepeatedGlyphs.forPage(options),
    unpairedTitleBands: new Map<number, QwenRuledTitleBand>(),
  };
  for (const block of eligible) {
    if (options.signal?.aborted) throw createAbortError();
    mergePatternBlock(working, context, block);
  }
  if (options.mode === "flux-region" || options.mode === "codex-region") {
    prepareGroupedRegionWindows(context, options);
  }
  finalizeMeasuredPaper(context, options.width);
  return context;
}

type PatternMaskOptions = Parameters<typeof buildPatternPageMask>[0] & {
  selectedDialogue?: ReadonlySet<string>;
  unpairedTitleBands: Map<number, QwenRuledTitleBand>;
  repeatedGlyphs?: QwenRepeatedGlyphs;
};

function mergePatternBlock(
  options: PatternMaskOptions,
  context: PatternMaskContext,
  block: MangaPage["blocks"][number],
): void {
  const sourceRect = bboxToPixelRect(block.bbox, options.page);
  const sourceGlyphEvidence =
    options.collectSourceGlyphEvidence === true
      ? buildSourceGlyphEvidence({
          ...options,
          bitmap: options.sourceEvidenceBitmap ?? options.bitmap,
          block,
        })
      : undefined;
  const supportRect = expandRect(
    sourceRect,
    options.width,
    options.height,
    options.mode === "codex-region"
      ? Math.max(
          2,
          Math.min(8, Math.ceil(Math.min(sourceRect.w, sourceRect.h) * 0.02)),
        )
      : resolvePatternRegionPaddingPx(block, options.page),
  );
  if (
    collectPaperGradient(
      options,
      block,
      sourceRect,
      context,
      sourceGlyphEvidence,
    )
  )
    return;
  if (options.mode === "flux-region" || options.mode === "codex-region") {
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
  context.inpaintSpeechBubbleWindows.push(false);
  if (detection.usedOtsu) context.otsuBlocks += 1;
  context.blocksErased += 1;
}

function mergeFluxRegionMask(
  options: PatternMaskOptions,
  context: PatternMaskContext,
  block: MangaPage["blocks"][number],
  supportRect: PixelRect,
  sourceGlyphEvidence: SourceGlyphEvidence | undefined,
): void {
  const sharedGroupIds = [
    ...(options.sharedInpaintGroupIdsByBlock?.[block.id] ?? []),
  ];
  const bubbleMask = resolveFluxBubbleConstraint(options, block);
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
    selectedDialogue: options.selectedDialogue,
    regionOnly: options.mode === "codex-region",
    conditionOnTypography: options.conditionOnTypography,
    bitmap: options.bitmap,
    repeatedGlyphs: options.repeatedGlyphs,
    block,
    fallbackConstraint: bubbleMask ? regionMask : null,
    outlinedReading:
      options.sourceEraseConstraintsByBlock?.[block.id]?.outlinedReading,
    selectedBalloonConstraint: bubbleMask
      ? sharedTypographyOwnership(options, block, sharedGroupIds, regionMask)
      : undefined,
    height: options.height,
    page: options.page,
    regionMask,
    segmentation: options.typographySegmentation,
    sourceRect: bboxToPixelRect(block.bbox, options.page),
    width: options.width,
  });
  protectSelectedRegion(options, block, plan);
  const { compositeMask, featherPx: compositeFeatherPx, modelMask } = plan;
  context.usesKoharuTypographyComposite ||= plan.usesTypographySegmentation;
  const bounds = modelMask.bounds;
  mergeMaskIntoPage(context.pageMask, options.width, bounds, modelMask.data);
  context.inpaintWindows.push(
    options.mode === "codex-region"
      ? bounds
      : expandRect(
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
  context.inpaintWindowGroupIds.push(
    selectedPrintGroups(
      block.id,
      plan,
      plan.sharedDialogueIds ?? sharedGroupIds,
    ),
  );
  pairQwenTitleWindows(
    options.unpairedTitleBands,
    context.inpaintWindowGroupIds,
    plan.titleBand,
  );
  // Only the job-local bubble prepass supplies this semantic hint. A typography
  // feather constraint by itself can also describe lettering over artwork.
  context.inpaintSpeechBubbleWindows.push(plan.speechBubble);
  if (usedOtsu) context.otsuBlocks += 1;
  context.blocksErased += 1;
}

function protectSelectedRegion(
  options: PatternMaskOptions,
  block: MangaPage["blocks"][number],
  plan: ReturnType<typeof resolvePatternFluxCompositePlan>,
) {
  const dialogueStrokes =
    options.bitmap &&
    options.conditionOnTypography &&
    plan.usesTypographySegmentation &&
    plan.speechBubble &&
    block.textRole !== "sound" &&
    block.bubbleLayout?.origin === "detected"
      ? { bitmap: options.bitmap, model: plan.modelMask }
      : undefined;
  protectUnselectedFluxPlan(plan, { ...options, dialogueStrokes });
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
  if (options.mode === "codex-region")
    return { regionMask: createFilledWindowMask(supportRect), usedOtsu: false };
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

type DetectionInput = Pick<
  PatternMaskOptions,
  "page" | "bitmap" | "width" | "height"
> & {
  block: MangaPage["blocks"][number];
  sourceRect: PixelRect;
};

function mergePatternDetectionMask(
  options: DetectionInput,
): PatternMaskDetectionResult {
  const detected = detectPatternTextWindowMask(options);
  if (detected) return detected;
  return {
    usedOtsu: false,
    windowMask: createFilledWindowMask(
      expandRect(options.sourceRect, options.width, options.height, 2),
    ),
  };
}

function detectPatternTextWindowMask(
  options: DetectionInput,
): PatternMaskDetectionResult | null {
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
  const data = projectWindowMask(createFilledWindowMask(supportRect), bounds);
  const relative = {
    ...detectedMask.bounds,
    x: detectedMask.bounds.x - bounds.x,
    y: detectedMask.bounds.y - bounds.y,
  };
  mergeMaskIntoPage(data, bounds.w, relative, detectedMask.data);
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
