import {
  normalizeRenderDirection,
  resolveFontWidthScale,
} from "../../../shared/geometry";
import { parseRichText } from "../../../shared/richTextMarkup";
import {
  resolveBlockTextWordBreak,
  type TextWordBreak,
} from "../../../shared/textWrapping";
import type { TranslationBlock } from "../../../shared/textTypes";
import { resolveBlockFontFamily, type BlockFontCatalog } from "./fonts";
import {
  measureStyledWrappedText,
  measureUniformStyledWrappedText,
  type BlockTextLine,
} from "./overlayTextWrapping";
import {
  resolveDefaultVerticalGraphemeAdvancePx,
  resolveVerticalGraphemeAdvancePx,
  segmentVerticalTextGraphemes,
} from "./verticalTextSpacing";
import {
  createTextRunStyleResolver,
  resolveMaximumTextRunFontSizePx,
} from "./textStyleRunResolution";

const MAX_VERTICAL_COLUMNS = 2;

let measureCanvas: HTMLCanvasElement | null = null;

export function resolveHorizontalTextContentWidth(
  block: TranslationBlock,
  innerWidth: number,
): number {
  return normalizeRenderDirection(block.renderDirection, "horizontal") ===
    "vertical"
    ? innerWidth
    : innerWidth / resolveFontWidthScale(block.fontWidthScale);
}

export function resolveFixedHorizontalTextLines(
  block: TranslationBlock,
  text: string,
  fontSize: number,
  contentWidth: number,
  fontCatalog: BlockFontCatalog,
): BlockTextLine[] | null {
  if (
    !text.trim() ||
    normalizeRenderDirection(block.renderDirection, "horizontal") === "vertical"
  ) {
    return null;
  }
  const { runs } = parseRichText(
    text,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  const resolveRunStyle = createTextRunStyleResolver(
    block,
    fontSize,
    fontCatalog,
  );
  return measureStyledWrappedText(
    getTextMeasureContext(),
    runs,
    contentWidth,
    fontSize * block.lineHeight,
    fontSize,
    resolveBlockFontFamily(block.fontFamily, fontCatalog),
    resolveLetterSpacingPx(block, fontSize),
    resolveBlockTextWordBreak(block.wordBreak, "horizontal"),
    resolveRunStyle,
  ).lines;
}

export function doesBlockTextFit(
  block: TranslationBlock,
  text: string,
  fontSize: number,
  innerWidth: number,
  innerHeight: number,
  fontCatalog: BlockFontCatalog,
): boolean {
  const letterSpacingPx = resolveLetterSpacingPx(block, fontSize);
  const scaleX = resolveFontWidthScale(block.fontWidthScale);
  const { runs } = parseRichText(
    text,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  if (
    normalizeRenderDirection(block.renderDirection, "horizontal") === "vertical"
  ) {
    return measureVerticalText(
      runs,
      block,
      fontCatalog,
      fontSize,
      innerWidth,
      innerHeight,
      fontSize * block.lineHeight,
      letterSpacingPx,
      scaleX,
      resolveBlockTextWordBreak(block.wordBreak, "vertical"),
    ).fits;
  }

  const effectiveWidth = innerWidth / scaleX;
  const measured = measureStyledWrappedText(
    getTextMeasureContext(),
    runs,
    effectiveWidth,
    fontSize * block.lineHeight,
    fontSize,
    resolveBlockFontFamily(block.fontFamily, fontCatalog),
    letterSpacingPx,
    resolveBlockTextWordBreak(block.wordBreak, "horizontal"),
    createTextRunStyleResolver(block, fontSize, fontCatalog),
  );
  return (
    measured.totalHeight <= innerHeight &&
    measured.maxLineWidth <= effectiveWidth
  );
}

export function resolveLetterSpacingPx(
  block: TranslationBlock,
  fontSize: number,
): number {
  const em = block.letterSpacing;
  return em && Number.isFinite(em) ? em * fontSize : 0;
}

export function getTextMeasureContext(): CanvasRenderingContext2D {
  if (typeof document === "undefined") {
    throw new Error("Document is not available for canvas text measurement");
  }
  measureCanvas ??= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (!context) throw new Error("Canvas context is not available");
  return context;
}

function measureVerticalText(
  runs: ReturnType<typeof parseRichText>["runs"],
  block: TranslationBlock,
  fontCatalog: BlockFontCatalog,
  fontSize: number,
  maxWidth: number,
  maxHeight: number,
  lineHeightPx: number,
  letterSpacingPx: number,
  fontWidthScale: number,
  wordBreak: TextWordBreak,
): { columnCount: number; fits: boolean } {
  const plainText = runs.map((run) => run.text).join("");
  if (!plainText.trim()) return { columnCount: 0, fits: true };
  const resolveRunStyle = createTextRunStyleResolver(
    block,
    fontSize,
    fontCatalog,
  );
  const maximumFontSizePx = resolveMaximumTextRunFontSizePx(
    runs,
    block,
    fontSize,
  );
  const defaultAdvancePx = resolveDefaultVerticalGraphemeAdvancePx(
    fontSize,
    lineHeightPx,
    letterSpacingPx,
  );
  const measured = measureUniformStyledWrappedText(
    runs,
    maxHeight,
    maximumFontSizePx * block.lineHeight,
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
  const columnCount = Math.max(1, measured.lineCount);
  const estimatedColumnWidth = maximumFontSizePx * 1.15 * fontWidthScale;
  return {
    columnCount,
    fits:
      columnCount <= MAX_VERTICAL_COLUMNS &&
      columnCount * estimatedColumnWidth <= maxWidth &&
      measured.maxLineWidth <= maxHeight,
  };
}
