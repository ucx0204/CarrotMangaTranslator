import {
  canMeasureSelectedInk,
  completeSelectedPrintPlan,
  selectedInkPlan,
  type FluxPlan,
  type FluxPlanOptions,
} from "./qwenSelectedPlan";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { intersectWindowMask } from "./bubbleLayoutConstraintMask";
import { measureQwenCaptionStock } from "./qwenCaptionStock";
import {
  balloonPrintOutline,
  ownedPrintDetections,
  registerEnclosedType,
  jointlySelectedBalloonPrint,
} from "./qwenDetectedPrintEdge";
import {
  completeLayeredDisplayTitle,
  completeOutlinedColumns,
} from "./qwenOutlinedColumns";
import {
  measureQwenFramedScreen,
  framedSoundInk,
  ruledGutterComposite,
} from "./qwenFramedScreen";
import {
  buildKoharuTypographyCompositeMask,
  resolveKoharuTypographyFeatherPx,
  unionWindowMasks,
} from "./koharuTypographyMask";
import {
  recoverOutlinedBrushEffect,
  measureDetectedBrush,
  completeQwenDisplayInk,
  completeQwenOutlinedLettering,
} from "./qwenOutlinedLettering";
import {
  completeContextualCredit,
  measureCreatorCaptions,
  measureQwenPrintGlow,
  measureQwenSoundEffectKeyline,
} from "./qwenPrintGlow";
import {
  completeSelectedCaptionColumn,
  measureLargeOutlinedSound,
  recoverUndetectedPrint,
} from "./qwenSelectedPrint";
import { recoverQwenRuledTitle } from "./qwenRuledTitle";
import { measuredQwenSubtitle } from "./qwenPrintedSubtitle";
import {
  completeTaperedSound,
  measureHorizontalSound,
} from "./qwenHorizontalSound";
import { measureSmallSelectedSound } from "./qwenSmallSound";
import { measureRuledSound } from "./qwenRuledPaper";

export function resolvePatternFluxCompositePlan(
  options: FluxPlanOptions,
): FluxPlan {
  const speechBubble = options.fallbackConstraint !== null;
  const featherPx = resolveKoharuTypographyFeatherPx(
    options.block,
    options.page,
  );
  if (options.regionOnly)
    return { ...selectedInkPlan(options.regionMask), speechBubble };
  const edge = options.outlinedReading;
  if (options.conditionOnTypography && edge)
    return {
      ...selectedInkPlan(edge),
      isolatedTitleStock: "balloon-edge-reading",
    };
  const framed = framedSoundInk(options);
  if (framed) return { ...selectedInkPlan(framed), speechBubble };
  const plan =
    selectedHandwrittenSound(options) ??
    detectedPrintPlan(options, speechBubble, featherPx);
  const reading = options.block.sourceText.normalize("NFKC").trim();
  const crossing = completeSelectedPrintPlan(options, plan, reading);
  if (crossing) return crossing;
  if (isCompactReviewedSound(options, plan))
    plan.soundReading ??= options.block.sourceText.normalize("NFKC").trim();
  return plan;
}

function isCompactReviewedSound(options: FluxPlanOptions, plan: FluxPlan) {
  const { w, h } = plan.modelMask.bounds;
  return (
    options.conditionOnTypography &&
    !plan.speechBubble &&
    options.block.textRole === "sound" &&
    Math.max(w, h) <= Math.min(options.width, options.height) * 0.14
  );
}

function detectedPrintPlan(
  options: FluxPlanOptions,
  speechBubble: boolean,
  featherPx: number,
): FluxPlan {
  const segmentation = ownedPrintDetections(options);
  const typography = segmentation
    ? buildKoharuTypographyCompositeMask({
        block: options.block,
        featherPx,
        height: options.height,
        ...(options.fallbackConstraint
          ? { ownedRegionMask: options.fallbackConstraint }
          : {}),
        page: options.page,
        segmentation,
        requireInkInSourceRect: canMeasureSelectedInk(options),
        completeOutline: qwenOutlineCompletion(options),
        sourceRect: options.sourceRect,
        width: options.width,
      })
    : null;
  if (typography?.measuredBrush)
    return selectedInkPlan(
      {
        ...typography.instance,
        measuredBrush: typography.measuredBrush,
        measuredSoundOutline: true,
      },
      typography.core,
    );
  if (typography && options.fallbackConstraint) {
    const joint = jointlySelectedBalloonPrint(options, typography.instance);
    if (joint)
      return {
        ...selectedInkPlan(joint.ink),
        speechBubble: true,
        sharedDialogueIds: joint.ids,
      };
    const printed = measuredPrintPlan(
      options,
      typography.instance,
      options.fallbackConstraint,
    );
    if (printed) return printed;
    const owned = registerEnclosedType(
      options,
      typography,
      options.fallbackConstraint,
    );
    typography.core = intersectWindowMask(typography.core, owned);
    typography.featherEnvelope = intersectWindowMask(
      typography.featherEnvelope,
      owned,
    );
  }
  if (!typography || !typography.core.data.some(Boolean)) {
    return fallbackPrintPlan(options, featherPx);
  }
  return detectedInkPlan(options, typography, featherPx, speechBubble);
}
function detectedInkPlan(
  options: FluxPlanOptions,
  typography: NonNullable<
    ReturnType<typeof buildKoharuTypographyCompositeMask>
  >,
  featherPx: number,
  speechBubble: boolean,
): FluxPlan {
  const condition = options.conditionOnTypography
    ? intersectWindowMask(typography.instance, typography.core)
    : null;
  return {
    compositeMask: typography.core,
    constraint: typography.featherEnvelope,
    featherPx,
    modelMask: condition?.data.some(Boolean)
      ? condition
      : unionWindowMasks(options.regionMask, typography.featherEnvelope),
    usesTypographySegmentation: true,
    speechBubble,
  };
}

function selectedHandwrittenSound(options: FluxPlanOptions) {
  if (!canMeasureSelectedInk(options)) return;
  const { bitmap, sourceRect, block } = options;
  const text = block.sourceText.normalize("NFKC").trim();
  const selected =
    measureHorizontalSound(bitmap, options, sourceRect, text) ??
    measureLargeOutlinedSound(bitmap, options, sourceRect, text) ??
    measureSmallSelectedSound(
      bitmap,
      options,
      sourceRect,
      text,
      block.textRole === "sound",
    );
  if (selected) return selectedInkPlan(selected);
}

function fallbackPrintPlan(
  options: FluxPlanOptions,
  featherPx: number,
): FluxPlan {
  const original = {
    compositeMask: options.regionMask,
    constraint: options.fallbackConstraint,
    featherPx,
    modelMask: options.regionMask,
    usesTypographySegmentation: false,
    speechBubble: options.fallbackConstraint !== null,
  };
  if (!canMeasureSelectedInk(options)) return original;
  const mask =
    recoverQwenRuledTitle(options.bitmap, options, options.sourceRect) ??
    recoverSelectedPrint(options, options.bitmap);
  if (!mask) return original;
  return selectedInkPlan(
    mask,
    selectedEffectComposite(options, options.bitmap, mask),
  );
}

function selectedEffectComposite(
  options: FluxPlanOptions,
  bitmap: Buffer,
  mask: InpaintingWindowMask,
) {
  return options.segmentation?.contextualText?.get(options.block.id)?.label ===
    "onomatopoeia"
    ? ruledGutterComposite(bitmap, options, mask)
    : mask;
}

function recoverSelectedPrint(options: FluxPlanOptions, bitmap: Buffer) {
  const detected = options.segmentation?.contextualText?.get(options.block.id);
  if (detected?.label === "onomatopoeia")
    return (
      recoverOutlinedBrushEffect(bitmap, options, detected) ??
      completeSoundEffect(bitmap, options, detected) ??
      detected
    );
  if (detected) {
    const credit = completeContextualCredit(bitmap, options, detected);
    const caption = measureCreatorCaptions(
      bitmap,
      options,
      options.sourceRect,
      options.block.sourceText,
      detected,
    );
    return caption ? unionWindowMasks(credit, caption) : credit;
  }
  return recoverUndetectedPrint(bitmap, options, options.block.sourceText);
}

function measuredPrintPlan(
  options: FluxPlanOptions,
  instance: InpaintingWindowMask,
  constraint: InpaintingWindowMask,
): FluxPlan | undefined {
  if (
    !options.conditionOnTypography ||
    !options.bitmap ||
    options.block.bubbleLayout?.origin === "manual"
  )
    return;
  const ruled = measureRuledSound(options.bitmap, options, instance);
  if (ruled) return selectedInkPlan(ruled);
  const keyline =
    measureQwenFramedScreen(options.bitmap, options, instance, constraint) ??
    measureQwenPrintGlow(options.bitmap, options, instance, constraint);
  if (!keyline) return;
  const mask = intersectWindowMask(constraint, keyline);
  return {
    compositeMask: mask,
    modelMask: mask,
    constraint,
    featherPx: 1,
    usesTypographySegmentation: true,
    speechBubble: false,
  };
}

function qwenOutlineCompletion(
  options: FluxPlanOptions,
): Parameters<typeof buildKoharuTypographyCompositeMask>[0]["completeOutline"] {
  const { bitmap } = options;
  if (!bitmap || !options.conditionOnTypography) return;
  const balloon = options.fallbackConstraint;
  if (balloon) return balloonPrintOutline(options, bitmap, balloon);
  return (instance, hits) => {
    if (hits.some((hit) => hit.label === "onomatopoeia")) {
      if (
        options.block.textRole === "sound" &&
        options.block.bubbleLayout?.origin !== "manual"
      ) {
        const measured = measureDetectedBrush(
          bitmap,
          options,
          instance,
          hits.length > 1,
        );
        if (measured) return measured;
      }
      if (hits.length === 1)
        return completeSoundEffect(bitmap, options, instance);
    }
    if (hits.every((h) => h.label === "text"))
      return completePrintedText(bitmap, options, instance);
  };
}

function completePrintedText(
  bitmap: Buffer,
  options: FluxPlanOptions,
  instance: InpaintingWindowMask,
) {
  const original = instance;
  const caption = measureQwenCaptionStock(bitmap, options, instance);
  if (caption) return caption;
  let subtitle: InpaintingWindowMask | undefined;
  const contextual = options.segmentation?.contextualText?.get(
    options.block.id,
  );
  if (contextual) {
    instance = unionWindowMasks(instance, contextual);
    subtitle = measuredQwenSubtitle(
      bitmap,
      options.width,
      options.sourceRect,
      instance,
    );
  }
  const repeated = options.repeatedGlyphs?.complete(
    instance,
    options.sourceRect,
  );
  const glow = measureQwenPrintGlow(bitmap, options, instance);
  const display = completeQwenDisplayInk(
    bitmap,
    options,
    instance,
    options.sourceRect,
  );
  const complete = [
    subtitle,
    options.block.textRole === "ordinary" &&
    options.block.sourceText.trim().length >= 7
      ? completeSelectedCaptionColumn(
          bitmap,
          options,
          options.sourceRect,
          instance,
        )
      : undefined,
    measureCreatorCaptions(
      bitmap,
      options,
      options.sourceRect,
      options.block.sourceText,
      instance,
    ),
    repeated,
    glow,
    display,
  ].reduce<InpaintingWindowMask>(
    (mask, addition) => (addition ? unionWindowMasks(mask, addition) : mask),
    instance,
  );
  return (
    completeLayeredDisplayTitle(
      bitmap,
      options,
      complete,
      options.sourceRect,
    ) ??
    completeOutlinedColumns(bitmap, options, complete) ??
    (complete === original ? undefined : complete)
  );
}

function completeSoundEffect(
  bitmap: Buffer,
  options: FluxPlanOptions,
  instance: InpaintingWindowMask,
) {
  if (options.block.textRole === "sound") {
    const tapered = completeTaperedSound(bitmap, options, instance);
    if (tapered) return tapered;
  }
  const outline = completeQwenOutlinedLettering(bitmap, options, instance);
  const rim = measureQwenSoundEffectKeyline(bitmap, options, instance);
  return outline && rim ? unionWindowMasks(outline, rim) : (outline ?? rim);
}
