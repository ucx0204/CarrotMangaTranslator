import { parseRichText } from "../../../shared/richTextMarkup";
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
  const renderDirection = normalizeRenderDirection(
    block.renderDirection,
    "horizontal",
  );
  const { runs, plainText } = parseRichText(
    text,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  const maximumFontSizePx = resolveMaximumTextRunFontSizePx(
    runs,
    block,
    fontSize,
  );
  const lineHeightPx = maximumFontSizePx * block.lineHeight;
  const letterSpacingPx = resolveLetterSpacingPx(block, fontSize);
  const fontWidthScale = resolveFontWidthScale(block.fontWidthScale);
  const resolveRunStyle = createTextRunStyleResolver(
    block,
    fontSize,
    fontCatalog,
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
    (text, run) =>
      segmentVerticalTextGraphemes(text, run.verticalCombine === true),
  );
}
