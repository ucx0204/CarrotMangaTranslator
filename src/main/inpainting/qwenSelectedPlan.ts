import { measuredRuledShadow } from "./qwenRuledShadow";
import { measureDuotoneOverprint } from "./qwenOverprint";
import { inlineCreatorCredit } from "./qwenCreatorCaption";
import { completeKeylinedKana } from "./qwenSelectedPrint";
import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { PixelRect } from "./maskGeometry";
import type { QwenRepeatedGlyphs } from "./qwenRepeatedGlyphs";
import type { QwenRuledTitleBand } from "./qwenRuledTitle";
import { unionWindowMasks, type MeasuredBrush } from "./koharuTypographyMask";
import { washedDisplayTitle } from "./qwenTextArtwork";
import {
  completePairedStops,
  measurePanelCrossingPrint,
} from "./qwenPanelCrossingPrint";
import {
  isolatedLayeredTitle,
  keylinedSceneCaption,
  measuredCaptionEnvelope,
  measuredColouredCaption,
} from "./qwenCaptionEnvelope";

export type FluxPlanOptions = {
  block: TranslationBlock;
  selectedDialogue?: ReadonlySet<string>;
  fallbackConstraint: InpaintingWindowMask | null;
  outlinedReading?: InpaintingWindowMask;
  selectedBalloonConstraint?: InpaintingWindowMask;
  height: number;
  page: MangaPage;
  regionMask: InpaintingWindowMask;
  segmentation?: KoharuTypographySegmentation;
  sourceRect: PixelRect;
  width: number;
  regionOnly?: boolean;
  conditionOnTypography?: boolean;
  bitmap?: Buffer;
  repeatedGlyphs?: QwenRepeatedGlyphs;
};
export type PrintSelection = {
  isolatedTitleStock?:
    boolean | "duotone-overlay" | "ruled-sound-shadow" | "balloon-edge-reading";
  washedTitle?: string;
  measuredBrush?: MeasuredBrush;
  colouredCaption?: string;
  measuredCaptionOutline?: boolean;
  compositeOutline?: InpaintingWindowMask;
  soundReading?: string;
  measuredSoundOutline?: boolean;
  masthead?: boolean;
  titleBand?: QwenRuledTitleBand;
};
export type FluxPlan = PrintSelection & {
  sharedDialogueIds?: string[];
  compositeMask: InpaintingWindowMask;
  constraint: InpaintingWindowMask | null;
  featherPx: number;
  modelMask: InpaintingWindowMask;
  usesTypographySegmentation: boolean;
  speechBubble: boolean;
};

export function canMeasureSelectedInk(
  options: FluxPlanOptions,
): options is FluxPlanOptions & {
  bitmap: Buffer;
  segmentation: KoharuTypographySegmentation;
} {
  return !(
    !options.conditionOnTypography ||
    !options.segmentation ||
    !options.bitmap ||
    options.fallbackConstraint ||
    options.block.bubbleLayout?.origin === "manual"
  );
}

export function selectedInkPlan(
  mask: InpaintingWindowMask & PrintSelection,
  composite: InpaintingWindowMask = mask.compositeOutline ?? mask,
): FluxPlan {
  return {
    titleBand: mask.titleBand,
    soundReading: mask.soundReading,
    measuredSoundOutline: mask.measuredSoundOutline,
    ...(mask.measuredBrush ? { measuredBrush: mask.measuredBrush } : {}),
    ...(mask.colouredCaption !== undefined
      ? { colouredCaption: mask.colouredCaption }
      : {}),
    masthead: mask.masthead,
    compositeMask: composite,
    modelMask: mask,
    constraint: composite,
    featherPx: 0,
    usesTypographySegmentation: false,
    speechBubble: false,
  };
}

export function completeSelectedPrintPlan(
  options: FluxPlanOptions,
  plan: FluxPlan,
  reading: string,
) {
  if (
    !options.conditionOnTypography ||
    !options.bitmap ||
    options.block.bubbleLayout?.origin === "manual"
  )
    return;
  const bitmap = options.bitmap;
  const caption =
    selectedOverlay(options, plan, reading) ??
    selectedSceneCaption(bitmap, options, plan, reading);
  if (caption) return caption;
  if (isDisplayReading(plan, reading)) {
    const washed = washedDisplayTitle(
      bitmap,
      options.width,
      options.height,
      plan.modelMask,
    );
    if (washed) return { ...selectedInkPlan(washed), washedTitle: reading };
  }
  const coloured = selectedColouredCaption(bitmap, options, plan, reading);
  if (coloured) return coloured;
  applyCaptionEnvelope(bitmap, options, plan, reading);
  if (!options.segmentation) return;
  addDetachedPrint(bitmap, options, plan, reading);
  if (isCrossingReading(options, plan, reading)) {
    return crossingPrintPlan(bitmap, options, plan, reading);
  }
}

function isDisplayReading(plan: FluxPlan, reading: string) {
  return !plan.speechBubble && reading.length >= 7;
}

function selectedOverlay(
  options: FluxPlanOptions,
  plan: FluxPlan,
  reading: string,
) {
  if (
    options.bitmap &&
    !plan.speechBubble &&
    options.block.textRole === "sound"
  ) {
    const shadow = measuredRuledShadow(
      options.bitmap,
      options.page,
      plan.modelMask,
    );
    if (shadow)
      return {
        ...selectedInkPlan(shadow),
        isolatedTitleStock: "ruled-sound-shadow" as const,
      };
  }
  if (
    canMeasureSelectedInk(options) &&
    !plan.speechBubble &&
    options.block.textRole === "ordinary" &&
    reading.length >= 2
  ) {
    const overprint = measureDuotoneOverprint(
      options.bitmap,
      options.page,
      options.sourceRect,
    );
    if (overprint)
      return {
        ...selectedInkPlan(overprint),
        isolatedTitleStock: "duotone-overlay" as const,
      };
  }
}

function selectedSceneCaption(
  bitmap: Buffer,
  options: FluxPlanOptions,
  plan: FluxPlan,
  reading: string,
) {
  if (
    !plan.speechBubble &&
    options.block.textRole === "ordinary" &&
    !options.fallbackConstraint &&
    options.segmentation &&
    reading.length >= 3
  ) {
    const caption = keylinedSceneCaption(
      bitmap,
      options,
      options.sourceRect,
      plan.modelMask,
    );
    if (caption)
      return { ...selectedInkPlan(caption), isolatedTitleStock: true };
  }
}

function crossingPrintPlan(
  bitmap: Buffer,
  options: FluxPlanOptions,
  plan: FluxPlan,
  reading: string,
) {
  const crossing = measurePanelCrossingPrint(
    bitmap,
    options.page,
    options.sourceRect,
    plan.modelMask,
  );
  if (!crossing) return;
  const registered = unionWindowMasks(plan.modelMask, crossing);
  return selectedInkPlan(
    { ...registered, soundReading: reading, measuredSoundOutline: true },
    unionWindowMasks(plan.compositeMask, crossing),
  );
}

function selectedColouredCaption(
  bitmap: Buffer,
  options: FluxPlanOptions,
  plan: FluxPlan,
  reading: string,
) {
  if (plan.speechBubble || options.block.textRole === "sound") return;
  if (!plan.usesTypographySegmentation) {
    const credit = inlineCreatorCredit(
      bitmap,
      options.page,
      options.sourceRect,
      reading,
    );
    if (credit) return selectedInkPlan(credit);
    const rect = options.sourceRect;
    // A display title can occupy several rows in one OCR box. Its dark
    // coloured strokes and white keylines also identify the undetected row.
    if (
      !options.fallbackConstraint &&
      rect.w >= options.width * 0.5 &&
      rect.h >= Math.min(options.width, options.height) * 0.14 &&
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー・]{7,}$/u.test(
        reading,
      )
    ) {
      const title = isolatedLayeredTitle(bitmap, options.page, rect);
      if (title)
        return {
          ...selectedInkPlan(title.modelMask),
          ...title,
          isolatedTitleStock: true,
        };
    }
    return;
  }
  const pigment = measuredColouredCaption(bitmap, options, plan.modelMask);
  if (pigment) return selectedInkPlan({ ...pigment, colouredCaption: reading });
}

function isCrossingReading(
  options: FluxPlanOptions,
  plan: FluxPlan,
  reading: string,
) {
  return (
    !plan.measuredSoundOutline &&
    reading.length <= 7 &&
    (plan.speechBubble || options.block.textRole === "sound")
  );
}

function addDetachedPrint(
  bitmap: Buffer,
  options: FluxPlanOptions,
  plan: FluxPlan,
  reading: string,
) {
  const stops:
    | (InpaintingWindowMask & { registered?: InpaintingWindowMask })
    | false
    | undefined = /(?:!\?|\?!)$/u.test(reading)
    ? completePairedStops(
        bitmap,
        options.page,
        options.sourceRect,
        plan.modelMask,
      )
    : !plan.speechBubble &&
      options.block.textRole === "sound" &&
      completeKeylinedKana(
        bitmap,
        options,
        options.sourceRect,
        plan.modelMask,
        reading,
        plan.constraint,
      );
  if (stops) {
    plan.modelMask = unionWindowMasks(plan.modelMask, stops);
    plan.compositeMask = unionWindowMasks(plan.compositeMask, stops);
    if (stops.registered) plan.constraint = stops.registered;
    else if (plan.constraint)
      plan.constraint = unionWindowMasks(plan.constraint, stops);
  }
}

function applyCaptionEnvelope(
  bitmap: Buffer,
  options: FluxPlanOptions,
  plan: FluxPlan,
  reading: string,
) {
  if (
    plan.usesTypographySegmentation &&
    !plan.speechBubble &&
    options.block.textRole === "ordinary" &&
    reading.length >= 9
  ) {
    const envelope = measuredCaptionEnvelope(
      bitmap,
      options.page,
      options.sourceRect,
      plan.modelMask,
    );
    if (envelope)
      Object.assign(plan, envelope, { measuredCaptionOutline: true });
  }
}
