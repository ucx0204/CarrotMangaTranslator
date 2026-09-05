import { parseRichText } from "../../../shared/richTextMarkup";
import { isGeneratedBubbleLayout } from "../../../shared/bubbleLayout";
import { measureStyledGraphemes } from "./overlayTextWrapping";
import {
  compareBalancedParagraphs,
  measureBalancedBubbleParagraph,
} from "./balancedBubbleTextWrapping";
import { resolveBlockTextWordBreak } from "../../../shared/textWrapping";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  getTextMeasureContext,
  resolveLetterSpacingPx,
} from "./blockTextMeasurement";
import { resolveBubbleTextSlotPlans } from "./bubbleTextLayout";
import {
  measureStyledWrappedTextInSlots,
  measureUniformStyledWrappedTextInSlots,
} from "./bubbleTextWrapping";
import { resolveBlockFontFamily, type BlockFontCatalog } from "./fonts";
import {
  normalizeRenderDirection,
  resolveFontWidthScale,
} from "./blockFormatGeometry";
import {
  resolveDefaultVerticalGraphemeAdvancePx,
  resolveVerticalGraphemeAdvancePx,
  segmentVerticalTextGraphemes,
} from "./verticalTextSpacing";
import {
  createTextRunStyleResolver,
  resolveMaximumTextRunFontSizePx,
  type TextRunStyleResolver,
} from "./textStyleRunResolution";

export function resolveBubbleWrappedText(
  block: TranslationBlock,
  text: string,
  fontSize: number,
  innerWidth: number,
  innerHeight: number,
  fontCatalog: BlockFontCatalog,
): ReturnType<typeof measureStyledWrappedTextInSlots> | null {
  if (block.curveLayout) return null;
  const context = createBubbleParagraphContext(
    block,
    text,
    fontSize,
    innerWidth,
    innerHeight,
    fontCatalog,
  );
  if (!context.plans.length) return null;
  // A failed balanced paragraph reaches size fitting, never greedy fallback.
  if (context.balanceParagraph) return measureBalancedPlans(context, fontSize);
  for (const slots of context.plans) {
    const measured = measureBubbleTextPlan(context, slots, block, fontSize);
    if (
      measured.fits &&
      measured.consumedAll &&
      measured.lineCount === slots.length
    )
      return measured;
  }
  return null;
}

function createBubbleParagraphContext(
  block: TranslationBlock,
  text: string,
  fontSize: number,
  innerWidth: number,
  innerHeight: number,
  fontCatalog: BlockFontCatalog,
) {
  const renderDirection = normalizeRenderDirection(
    block.renderDirection,
    "horizontal",
  );
  const { runs, plainText } = parseRichText(
    text,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  const lineHeightPx =
    resolveMaximumTextRunFontSizePx(runs, block, fontSize) * block.lineHeight;
  const fontWidthScale = resolveFontWidthScale(block.fontWidthScale);
  const balanceParagraph = shouldBalanceParagraph(
    block,
    renderDirection,
    plainText,
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
    preferBodyCenter: balanceParagraph,
    renderDirection,
  });
  return {
    runs,
    plans,
    renderDirection,
    balanceParagraph,
    lineHeightPx,
    letterSpacingPx: resolveLetterSpacingPx(block, fontSize),
    resolveRunStyle: createTextRunStyleResolver(block, fontSize, fontCatalog),
    wordBreak: resolveBlockTextWordBreak(block.wordBreak, renderDirection),
    fontFamily: resolveBlockFontFamily(block.fontFamily, fontCatalog),
  };
}

type BubbleParagraphContext = ReturnType<typeof createBubbleParagraphContext>;

function shouldBalanceParagraph(
  block: TranslationBlock,
  renderDirection: string,
  plainText: string,
): boolean {
  return (
    block.fontSizeIntent === "source-match" &&
    isGeneratedBubbleLayout(block.bubbleLayout) &&
    renderDirection === "horizontal" &&
    !/[\r\n]/u.test(plainText) &&
    Array.from(plainText).length <= 256
  );
}

function measureBalancedPlans(
  context: BubbleParagraphContext,
  fontSize: number,
) {
  const {
    runs,
    fontFamily,
    resolveRunStyle,
    plans,
    lineHeightPx,
    letterSpacingPx,
    wordBreak,
  } = context;
  const graphemes = measureStyledGraphemes(
    getTextMeasureContext(),
    runs,
    fontSize,
    fontFamily,
    resolveRunStyle,
  );
  let best: ReturnType<typeof measureBalancedBubbleParagraph> = null;
  for (const slots of plans) {
    if (
      best &&
      best.wordSplitCount === 0 &&
      best.fragmentLineCount === 0 &&
      slots.length > best.lineCount
    )
      break;
    const measured = measureBalancedBubbleParagraph(
      graphemes,
      slots,
      lineHeightPx,
      letterSpacingPx,
      wordBreak,
    );
    if (measured && (!best || compareBalancedParagraphs(measured, best) < 0))
      best = measured;
  }
  return best;
}

function measureBubbleTextPlan(
  context: BubbleParagraphContext,
  slots: BubbleParagraphContext["plans"][number],
  block: TranslationBlock,
  fontSize: number,
) {
  const {
    runs,
    renderDirection,
    lineHeightPx,
    letterSpacingPx,
    wordBreak,
    resolveRunStyle,
    fontFamily,
  } = context;
  return renderDirection === "vertical"
    ? measureVerticalStyledTextInSlots(
        runs,
        slots,
        lineHeightPx,
        fontSize,
        letterSpacingPx,
        wordBreak,
        block,
        resolveRunStyle,
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
        resolveRunStyle,
      );
}

function resolveMaximumTextSlotCount(plainText: string): number {
  return Math.max(1, Array.from(plainText.replace(/\r\n?/g, "\n")).length);
}

function measureVerticalStyledTextInSlots(
  runs: Parameters<typeof measureUniformStyledWrappedTextInSlots>[0],
  slots: Parameters<typeof measureUniformStyledWrappedTextInSlots>[1],
  lineHeightPx: number,
  fontSize: number,
  letterSpacingPx: number,
  wordBreak: Parameters<typeof measureUniformStyledWrappedTextInSlots>[4],
  block: TranslationBlock,
  resolveRunStyle: TextRunStyleResolver,
): ReturnType<typeof measureUniformStyledWrappedTextInSlots> {
  const defaultAdvancePx = resolveDefaultVerticalGraphemeAdvancePx(
    fontSize,
    lineHeightPx,
    letterSpacingPx,
  );
  return measureUniformStyledWrappedTextInSlots(
    runs,
    slots,
    lineHeightPx,
    defaultAdvancePx,
    wordBreak,
    (grapheme, style) => {
      const runLetterSpacingPx = (block.letterSpacing ?? 0) * style.fontSizePx;
      const runDefaultAdvancePx = resolveDefaultVerticalGraphemeAdvancePx(
        style.fontSizePx,
        style.fontSizePx * block.lineHeight,
        runLetterSpacingPx,
      );
      return resolveVerticalGraphemeAdvancePx(
        grapheme,
        style.fontSizePx,
        runDefaultAdvancePx,
        runLetterSpacingPx,
      );
    },
    resolveRunStyle,
    (text) => segmentVerticalTextGraphemes(text),
  );
}
