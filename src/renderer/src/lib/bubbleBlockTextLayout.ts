import { isGeneratedBubbleLayout } from "../../../shared/bubbleLayout";
import { parseRichText } from "../../../shared/richTextMarkup";
import { resolveBlockTextWordBreak } from "../../../shared/textWrapping";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  getTextMeasureContext,
  resolveLetterSpacingPx,
} from "./blockTextMeasurement";
import { resolveBubbleTextSlotPlans } from "./bubbleTextLayout";
import {
  assessWrappedTextQuality,
  measureStyledWrappedTextInSlots,
  measureUniformStyledWrappedTextInSlots,
  type WrappedTextQuality,
} from "./bubbleTextWrapping";
import { resolveBlockFontFamily, type BlockFontCatalog } from "./fonts";
import {
  normalizeRenderDirection,
  resolveFontWidthScale,
} from "./blockFormatGeometry";
import type { BlockTextLine } from "./overlayTextWrapping";

export type GeneratedBubbleQualityBudget = {
  plainText: string;
  baseline: WrappedTextQuality;
};

const SEVERE_FRAGMENT_MIN_GRAPHEMES = 12;
const SEVERE_FRAGMENT_MIN_WORD_SPLITS = 2;
const SEVERE_FRAGMENT_MAX_AVERAGE_GRAPHEMES = 3.2;

export function resolveBubbleWrappedText(
  block: TranslationBlock,
  text: string,
  fontSize: number,
  innerWidth: number,
  innerHeight: number,
  fontCatalog: BlockFontCatalog,
): ReturnType<typeof measureStyledWrappedTextInSlots> | null {
  if (block.curveLayout) return null;
  const renderDirection = normalizeRenderDirection(
    block.renderDirection,
    "horizontal",
  );
  const lineHeightPx = fontSize * block.lineHeight;
  const letterSpacingPx = resolveLetterSpacingPx(block, fontSize);
  const fontWidthScale = resolveFontWidthScale(block.fontWidthScale);
  const { runs, plainText } = parseRichText(
    text,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  const plans = resolveBubbleTextSlotPlans(block.bubbleLayout, {
    blockExtentPx: renderDirection === "vertical" ? innerWidth : innerHeight,
    inlineExtentPx: renderDirection === "vertical" ? innerHeight : innerWidth,
    fontWidthScale,
    lineHeightPx:
      renderDirection === "vertical"
        ? lineHeightPx * fontWidthScale
        : lineHeightPx,
    maximumSlotCount: resolveMaximumTextSlotCount(plainText),
    renderDirection,
  });
  if (plans.length === 0) return null;

  const wordBreak = resolveBlockTextWordBreak(block.wordBreak, renderDirection);
  const fontFamily = resolveBlockFontFamily(block.fontFamily, fontCatalog);
  for (const slots of plans) {
    const measured =
      renderDirection === "vertical"
        ? measureUniformStyledWrappedTextInSlots(
            runs,
            slots,
            lineHeightPx,
            resolveVerticalGraphemeAdvancePx(
              fontSize,
              lineHeightPx,
              letterSpacingPx,
            ),
            wordBreak,
          )
        : measureStyledWrappedTextInSlots(
            getTextMeasureContext(),
            runs,
            slots,
            lineHeightPx,
            fontSize,
            fontFamily,
            letterSpacingPx,
            wordBreak,
          );
    if (
      measured.fits &&
      measured.consumedAll &&
      measured.lineCount === slots.length
    ) {
      return measured;
    }
  }
  return null;
}

export function shouldGateGeneratedBubbleLayout(
  block: TranslationBlock,
  text: string,
): boolean {
  return (
    Boolean(text.trim()) &&
    (block.autoFitText ?? true) &&
    !block.curveLayout &&
    normalizeRenderDirection(block.renderDirection, "horizontal") ===
      "horizontal" &&
    isGeneratedBubbleLayout(block.bubbleLayout)
  );
}

export function resolveRectangularBubbleBaselineBlock(
  block: TranslationBlock,
): TranslationBlock {
  const baseline = { ...block };
  delete baseline.renderBbox;
  delete baseline.renderBboxSpace;
  delete baseline.bubbleLayout;
  return baseline;
}

export function createGeneratedBubbleQualityBudget({
  block,
  text,
  baselineLines,
}: {
  block: TranslationBlock;
  text: string;
  baselineLines: readonly BlockTextLine[] | null;
}): GeneratedBubbleQualityBudget | null {
  if (!shouldGateGeneratedBubbleLayout(block, text) || !baselineLines) {
    return null;
  }
  const { plainText } = parseRichText(
    text,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  return {
    plainText,
    baseline: assessWrappedTextQuality(plainText, baselineLines),
  };
}

export function doesGeneratedBubbleQualityFit(
  lines: readonly BlockTextLine[],
  budget: GeneratedBubbleQualityBudget,
): boolean {
  const candidateQuality = assessWrappedTextQuality(budget.plainText, lines);
  return (
    candidateQuality.intraWordSplitCount <=
      budget.baseline.intraWordSplitCount &&
    candidateQuality.orphanLineCount <= budget.baseline.orphanLineCount &&
    candidateQuality.lineCount <= budget.baseline.lineCount &&
    !isSeverelyFragmentedGeneratedText(candidateQuality)
  );
}

function isSeverelyFragmentedGeneratedText(
  quality: ReturnType<typeof assessWrappedTextQuality>,
): boolean {
  return (
    quality.semanticGraphemeCount >= SEVERE_FRAGMENT_MIN_GRAPHEMES &&
    quality.intraWordSplitCount >= SEVERE_FRAGMENT_MIN_WORD_SPLITS &&
    quality.averageSemanticGraphemesPerLine <
      SEVERE_FRAGMENT_MAX_AVERAGE_GRAPHEMES
  );
}

function resolveMaximumTextSlotCount(plainText: string): number {
  return Math.max(1, Array.from(plainText.replace(/\r\n?/g, "\n")).length);
}

function resolveVerticalGraphemeAdvancePx(
  fontSize: number,
  lineHeightPx: number,
  letterSpacingPx: number,
): number {
  return Math.max(1, Math.max(fontSize, lineHeightPx) + letterSpacingPx);
}
