import { isUsableBubbleLayout } from "./bubbleLayout";
import type { MangaPage } from "./libraryTypes";
import { stripRichTextMarkup } from "./richTextMarkup";
import type { TextLayoutIntent, TranslationBlock } from "./textTypes";

const MIN_EXTERIOR_VERTICAL_GRAPHEMES = 12;
const MIN_EXTERIOR_VERTICAL_ASPECT_RATIO = 2.5;
const MIN_EXTERIOR_VERTICAL_PAGE_HEIGHT_RATIO = 0.2;
const MAX_EXTERIOR_VERTICAL_CENTER_X_RATIO = 0.22;
export const MIN_EXTERIOR_VERTICAL_NARRATION_CONFIDENCE = 0.82;

export function readTextLayoutIntent(
  value: unknown,
): TextLayoutIntent | undefined {
  return value === "auto" || value === "horizontal" || value === "vertical"
    ? value
    : undefined;
}

export function readUnsuppressedTextLayoutIntent(
  block: Pick<TranslationBlock, "layoutIntent" | "layoutIntentSuppressed">,
): TextLayoutIntent | undefined {
  return block.layoutIntentSuppressed === true
    ? undefined
    : readTextLayoutIntent(block.layoutIntent);
}

/**
 * Reconcile a fresh model advisory with an existing persisted block. Concrete
 * advisories belong only to ordinary text; auto/missing and sound output clear
 * stale model metadata. An explicit user/default direction claim remains the
 * authority across retranslations. Horizontal is safe to apply immediately,
 * while vertical stays advisory until the non-bubble postprocess accepts it.
 */
export function applyModelTextLayoutIntent(
  block: TranslationBlock,
  value: unknown,
  textRole: TranslationBlock["textRole"],
): TranslationBlock {
  const layoutIntent = readConcreteModelTextLayoutIntent(
    block,
    value,
    textRole,
  );
  const hasStaleIntent =
    layoutIntent === undefined && Object.hasOwn(block, "layoutIntent");
  const changesIntent =
    layoutIntent !== undefined && block.layoutIntent !== layoutIntent;
  const forcesHorizontal =
    layoutIntent === "horizontal" && block.renderDirection !== "horizontal";
  if (!hasStaleIntent && !changesIntent && !forcesHorizontal) return block;

  const next: TranslationBlock = { ...block };
  if (layoutIntent) {
    next.layoutIntent = layoutIntent;
  } else {
    delete next.layoutIntent;
  }
  if (layoutIntent === "horizontal") {
    next.renderDirection = "horizontal";
  }
  return next;
}

function readConcreteModelTextLayoutIntent(
  block: Pick<TranslationBlock, "layoutIntentSuppressed">,
  value: unknown,
  textRole: TranslationBlock["textRole"],
): Exclude<TextLayoutIntent, "auto"> | undefined {
  if (block.layoutIntentSuppressed === true || textRole !== "ordinary") {
    return undefined;
  }
  const candidate = readTextLayoutIntent(value);
  return candidate === "horizontal" || candidate === "vertical"
    ? candidate
    : undefined;
}

/**
 * Accepts Gemma's rare vertical advisory only for a long, very tall ordinary
 * text container at the outer edge of the page. Source OCR geometry is read as
 * evidence only; this function never expands or relocates it.
 */
export function shouldApplyExteriorVerticalLayoutIntent(
  block: TranslationBlock,
  page: Pick<MangaPage, "width" | "height">,
): boolean {
  if (!hasExteriorVerticalNarrationEvidence(block)) {
    return false;
  }

  const semanticGraphemeCount = [...block.translatedText].filter((value) =>
    /[\p{L}\p{N}]/u.test(value),
  ).length;
  if (semanticGraphemeCount < MIN_EXTERIOR_VERTICAL_GRAPHEMES) return false;

  const rect = sourceBboxToPagePixels(block, page);
  const aspectRatio = rect.height / Math.max(1, rect.width);
  const pageHeightRatio = rect.height / Math.max(1, page.height);
  const centerXRatio = (rect.x + rect.width / 2) / Math.max(1, page.width);
  const atExteriorEdge =
    centerXRatio <= MAX_EXTERIOR_VERTICAL_CENTER_X_RATIO ||
    centerXRatio >= 1 - MAX_EXTERIOR_VERTICAL_CENTER_X_RATIO;
  return (
    aspectRatio >= MIN_EXTERIOR_VERTICAL_ASPECT_RATIO &&
    pageHeightRatio >= MIN_EXTERIOR_VERTICAL_PAGE_HEIGHT_RATIO &&
    atExteriorEdge
  );
}

function hasExteriorVerticalNarrationEvidence(
  block: TranslationBlock,
): boolean {
  return (
    readUnsuppressedTextLayoutIntent(block) === "vertical" &&
    block.textRole === "ordinary" &&
    block.fontRole === "narration" &&
    (block.fontRoleConfidence ?? 0) >=
      MIN_EXTERIOR_VERTICAL_NARRATION_CONFIDENCE &&
    !block.curveLayout &&
    !isUsableBubbleLayout(block.bubbleLayout) &&
    stripRichTextMarkup(block.translatedText) === block.translatedText
  );
}

function sourceBboxToPagePixels(
  block: TranslationBlock,
  page: Pick<MangaPage, "width" | "height">,
): { x: number; y: number; width: number; height: number } {
  if (block.bboxSpace === "pixels") {
    return {
      x: block.bbox.x,
      y: block.bbox.y,
      width: block.bbox.w,
      height: block.bbox.h,
    };
  }
  return {
    x: (block.bbox.x / 1000) * page.width,
    y: (block.bbox.y / 1000) * page.height,
    width: (block.bbox.w / 1000) * page.width,
    height: (block.bbox.h / 1000) * page.height,
  };
}
