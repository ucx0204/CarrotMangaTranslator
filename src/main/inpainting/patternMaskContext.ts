import { measuredPaperStop, finishPaperStop } from "./qwenPaperStops";
import { protectUnselectedFluxPlan } from "./patternBlockEligibility";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import {
  bboxToPixelRect,
  expandRect,
  mergeMaskIntoPage,
  type PixelRect,
} from "./maskGeometry";
import type { SourceGlyphEvidence } from "./sourceGlyphResidual";
import {
  finishPaperLettering,
  measurePaperLettering,
} from "./qwenPaperLettering";
import {
  pasteQwenPaperGradient,
  selectedPaperGradient,
  type MeasuredPaperPatch,
} from "./qwenPaperGradient";

export type PatternMaskContext = {
  pageMask: Uint8Array;
  inpaintWindows: PixelRect[];
  inpaintWindowMasks: InpaintingWindowMask[];
  inpaintCompositeMasks: InpaintingWindowMask[];
  inpaintCompositeFeatherPx: number[];
  inpaintWindowConstraints: Array<InpaintingWindowMask | null>;
  inpaintWindowGroupIds: string[][];
  inpaintSpeechBubbleWindows: boolean[];
  windowProcessingOrder?: readonly number[];
  usesKoharuTypographyComposite: boolean;
  validationWindowMasks: InpaintingWindowMask[];
  validationBlockIds: string[];
  sourceGlyphEvidence: SourceGlyphEvidence[];
  validationBindingsByBlockId: Map<
    string,
    {
      blockId: string;
      firstPassCore: InpaintingWindowMask;
      sourceGlyphEvidence: SourceGlyphEvidence;
    }
  >;
  blocksErased: number;
  otsuBlocks: number;
  supplementalPaper?: Array<MeasuredPaperPatch & { stem?: number[] }>;
  measuredPaper?: Array<{
    blockId: string;
    patch: MeasuredPaperPatch;
    evidence?: SourceGlyphEvidence;
  }>;
};

export function createEmptyPatternMaskContext(
  width: number,
  height: number,
): PatternMaskContext {
  return {
    pageMask: new Uint8Array(width * height),
    inpaintWindows: [],
    inpaintWindowMasks: [],
    inpaintCompositeMasks: [],
    inpaintCompositeFeatherPx: [],
    inpaintWindowConstraints: [],
    inpaintWindowGroupIds: [],
    inpaintSpeechBubbleWindows: [],
    usesKoharuTypographyComposite: false,
    validationWindowMasks: [],
    validationBlockIds: [],
    sourceGlyphEvidence: [],
    validationBindingsByBlockId: new Map(),
    blocksErased: 0,
    otsuBlocks: 0,
  };
}

export function appendPatternValidationBinding(
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
export function finalizeMeasuredPaper(
  context: PatternMaskContext,
  width: number,
) {
  for (const patch of context.supplementalPaper ?? [])
    mergeMaskIntoPage(context.pageMask, width, patch.bounds, patch.data);
  for (const { blockId, patch, evidence } of context.measuredPaper ?? []) {
    mergeMaskIntoPage(context.pageMask, width, patch.bounds, patch.data);
    appendPatternValidationBinding(context, blockId, patch, evidence);
    context.blocksErased++;
  }
}

export function collectPaperGradient(
  options: Parameters<typeof selectedPaperGradient>[0],
  block: Parameters<typeof selectedPaperGradient>[1],
  selection: PixelRect,
  context: PatternMaskContext,
  evidence?: SourceGlyphEvidence,
) {
  if (options.sourceEraseConstraintsByBlock?.[block.id]?.outlinedReading)
    return false;
  collectPaperCorrection(options, block, selection, context);
  const patch = selectedPaperGradient(
    options,
    block,
    selection,
    expandRect(selection, options.width, options.height, 14),
  );
  if (!patch) return false;
  (context.measuredPaper ??= []).push({ blockId: block.id, patch, evidence });
  return true;
}

export function pasteMeasuredPaper(
  context: PatternMaskContext,
  bitmap: Buffer,
  width: number,
) {
  for (const { patch } of context.measuredPaper ?? [])
    pasteQwenPaperGradient(patch, bitmap, width);
  for (const patch of context.supplementalPaper ?? []) {
    if (patch.stem)
      finishPaperStop({ ...patch, stem: patch.stem }, bitmap, width);
    else finishPaperLettering(patch, bitmap, width);
  }
}

function collectPaperCorrection(
  options: Parameters<typeof selectedPaperGradient>[0],
  block: Parameters<typeof selectedPaperGradient>[1],
  selection: PixelRect,
  context: PatternMaskContext,
) {
  if (
    options.conditionOnTypography &&
    options.typographySegmentation &&
    block.textRole === "ordinary" &&
    block.bubbleLayout?.origin !== "manual"
  ) {
    const bounds = expandRect(selection, options.width, options.height, 8);
    const owner = options.sourceEraseConstraintsByBlock?.[block.id];
    const correction = owner
      ? measuredPaperStop(
          options.bitmap,
          options.width,
          selection,
          owner,
          block.sourceText,
        )
      : measurePaperLettering({ ...options, bounds, selection });
    if (correction) {
      const protectedPlan = {
        modelMask: correction,
        compositeMask: correction,
        constraint: correction,
        featherPx: 0,
      };
      // A detached stop can touch the padded protection around another label.
      // Its paired stem identifies it unless a second original box owns its centre.
      const stop = "stem" in correction;
      if (!stop || sharesStopCentre(options, block.id, correction.bounds))
        protectUnselectedFluxPlan(protectedPlan, options, options.bitmap);
      (context.supplementalPaper ??= []).push({
        ...correction,
        data: protectedPlan.compositeMask.data,
      });
    }
  }
}

function sharesStopCentre(
  options: Parameters<typeof selectedPaperGradient>[0],
  id: string,
  dot: PixelRect,
) {
  const x = dot.x + dot.w / 2,
    y = dot.y + dot.h / 2;
  return options.page.blocks.some((peer) => {
    if (peer.id === id) return false;
    const p = bboxToPixelRect(peer.bbox, options.page);
    return x >= p.x && y >= p.y && x < p.x + p.w && y < p.y + p.h;
  });
}
