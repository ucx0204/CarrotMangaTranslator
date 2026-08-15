import type { BBox, TranslationBlock } from "./textTypes";

type ReadableTextBlock = Partial<
  Pick<TranslationBlock, "letterSpacing" | "lineHeight" | "renderDirection">
>;

export const MIN_READABLE_FONT_SIZE_PX = 10;

const READABLE_AVERAGE_CHAR_WIDTH_RATIO = 0.95;
const READABLE_VERTICAL_COLUMN_WIDTH_RATIO = 1.15;
const READABLE_MAX_VERTICAL_COLUMNS = 2;

export function estimateReadableTextBoxSizePx(
  text: string,
  block: ReadableTextBlock,
  basePx: BBox,
): { width: number; height: number } {
  const compactLength = Math.max(
    1,
    [...text.replace(/\r/g, "").replace(/\n/g, " ")].length,
  );
  const fontSizePx = MIN_READABLE_FONT_SIZE_PX;
  const letterSpacingPx = (block.letterSpacing ?? 0) * fontSizePx;
  const lineHeightPx = fontSizePx * Math.max(1, block.lineHeight ?? 1.18);

  if (block.renderDirection === "vertical") {
    const verticalAdvancePx = Math.max(1, lineHeightPx + letterSpacingPx);
    const availableHeight = Math.max(1, basePx.h);
    const charsPerColumn = Math.max(
      1,
      Math.floor(availableHeight / verticalAdvancePx),
    );
    const columnCount = Math.min(
      READABLE_MAX_VERTICAL_COLUMNS,
      Math.max(1, Math.ceil(compactLength / charsPerColumn)),
    );
    return {
      width: columnCount * fontSizePx * READABLE_VERTICAL_COLUMN_WIDTH_RATIO,
      height: Math.min(compactLength, charsPerColumn) * verticalAdvancePx,
    };
  }

  const charAdvancePx = Math.max(
    1,
    fontSizePx * READABLE_AVERAGE_CHAR_WIDTH_RATIO + letterSpacingPx,
  );
  const availableWidth = Math.max(1, basePx.w);
  const naturalCharsPerLine =
    resolveNaturalHorizontalCharsPerLine(compactLength);
  const widthLimitedCharsPerLine = Math.max(
    1,
    Math.floor(availableWidth / charAdvancePx),
  );
  const charsPerLine = Math.max(
    Math.min(compactLength, naturalCharsPerLine),
    Math.min(compactLength, widthLimitedCharsPerLine),
  );
  const lineCount = Math.max(1, Math.ceil(compactLength / charsPerLine));
  return {
    width: charsPerLine * charAdvancePx,
    height: lineCount * lineHeightPx,
  };
}

function resolveNaturalHorizontalCharsPerLine(compactLength: number): number {
  if (compactLength <= 4) return compactLength;
  if (compactLength <= 10) return Math.min(compactLength, 5);
  return Math.min(
    compactLength,
    Math.max(6, Math.min(14, Math.ceil(Math.sqrt(compactLength * 5)))),
  );
}
