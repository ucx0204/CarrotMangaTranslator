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
