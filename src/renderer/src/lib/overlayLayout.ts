import type { TranslationBlock } from "../../../shared/textTypes";
import {
  bboxToPixels,
  clamp,
  MIN_READABLE_FONT_SIZE_PX,
  normalizeRenderDirection,
  resolveBlockRenderBbox,
  resolveEffectiveRenderBbox,
  resolveFontWidthScale,
} from "../../../shared/geometry";
import { parseRichText } from "../../../shared/richTextMarkup";
import { resolveBlockFontFamily } from "./fonts";
import {
  measureStyledWrappedText,
  type BlockTextLine,
} from "./overlayTextWrapping";

const MIN_FONT_SIZE_PX = MIN_READABLE_FONT_SIZE_PX;
const MAX_AUTOFIT_FONT_SIZE_PX = 256;
const MIN_INNER_SIZE_PX = 1;
const MAX_VERTICAL_COLUMNS = 2;

let measureCanvas: HTMLCanvasElement | null = null;

export type ViewportSize = {
  width: number;
  height: number;
};

export type PixelRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type BlockTextLayout = {
  rect: PixelRect;
  paddingPx: number;
  layoutWidth: number;
  layoutHeight: number;
  innerWidth: number;
  innerHeight: number;
  fitInnerWidth: number;
  fitInnerHeight: number;
  fontSizePx: number;
  textContentWidth: number;
  lines: BlockTextLine[] | null;
  textScaleX: number;
  textScaleY: number;
  overflow: boolean;
};

type BlockTextLayoutOptions = {
  textLayoutScale?: number;
  textLayoutStageSize?: ViewportSize;
};

export function resolveBlockPaddingPx(rect: PixelRect): number {
  void rect;
  return 0;
}

export function resolveBlockTextLayout(
  block: TranslationBlock,
  text: string,
  pageSize: ViewportSize,
  stageSize: ViewportSize,
  options: BlockTextLayoutOptions = {},
): BlockTextLayout {
  const { plainText } = parseRichText(
    text,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  const rect = resolveBlockRectPx(block, pageSize, stageSize, plainText);
  const layoutStageSize =
    options.textLayoutStageSize ??
    resolveTextLayoutStageSize(stageSize, options.textLayoutScale);
  const layoutRect = resolveBlockRectPx(
    block,
    pageSize,
    layoutStageSize,
    plainText,
  );
  const paddingPx = resolveBlockPaddingPx(layoutRect);
  // The text layer is borderless and fills the block (inset: 0), so the usable
  // box is the full rect. The PNG exporter uses the same full-rect box model.
  const layoutWidth = Math.max(MIN_INNER_SIZE_PX, layoutRect.width);
  const layoutHeight = Math.max(MIN_INNER_SIZE_PX, layoutRect.height);
  const innerWidth = Math.max(MIN_INNER_SIZE_PX, layoutWidth - paddingPx * 2);
  const innerHeight = Math.max(MIN_INNER_SIZE_PX, layoutHeight - paddingPx * 2);
  const fitInnerWidth = innerWidth;
  const fitInnerHeight = innerHeight;
  const scale = Math.min(
    layoutStageSize.width / Math.max(1, pageSize.width),
    layoutStageSize.height / Math.max(1, pageSize.height),
  );
  const preferredFontSize = Math.max(
    MIN_FONT_SIZE_PX,
    Math.floor(block.fontSizePx * scale),
  );
  const maxFontSize = resolveAutoFitUpperBound(
    block,
    preferredFontSize,
    fitInnerWidth,
    fitInnerHeight,
  );
  const fontSizePx = resolveTextFontSizePx(
    block,
    text,
    maxFontSize,
    fitInnerWidth,
    fitInnerHeight,
  );
  const textContentWidth = resolveHorizontalTextContentWidth(
    block,
    fitInnerWidth,
  );
  const lines = resolveFixedHorizontalTextLines(
    block,
    text,
    fontSizePx,
    textContentWidth,
  );

  return {
    rect,
    paddingPx,
    layoutWidth,
    layoutHeight,
    innerWidth,
    innerHeight,
    fitInnerWidth,
    fitInnerHeight,
    fontSizePx,
    textContentWidth,
    lines,
    textScaleX: rect.width / layoutWidth,
    textScaleY: rect.height / layoutHeight,
    overflow: text.trim()
      ? !doesTextFit(block, text, fontSizePx, fitInnerWidth, fitInnerHeight)
      : false,
  };
}

function resolveHorizontalTextContentWidth(
  block: TranslationBlock,
  innerWidth: number,
): number {
  if (
    normalizeRenderDirection(block.renderDirection, "horizontal") === "vertical"
  ) {
    return innerWidth;
  }
  return innerWidth / resolveFontWidthScale(block.fontWidthScale);
}

function resolveFixedHorizontalTextLines(
  block: TranslationBlock,
  text: string,
  fontSize: number,
  contentWidth: number,
): BlockTextLine[] | null {
  if (
    !text.trim() ||
    normalizeRenderDirection(block.renderDirection, "horizontal") === "vertical"
  ) {
    return null;
  }
  const letterSpacingPx = resolveLetterSpacingPx(block, fontSize);
  const { runs } = parseRichText(
    text,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  return measureStyledWrappedText(
    getMeasureContext(),
    runs,
    contentWidth,
    fontSize * block.lineHeight,
    fontSize,
    resolveBlockFontFamily(block.fontFamily),
    letterSpacingPx,
  ).lines;
}

function resolveTextLayoutStageSize(
  stageSize: ViewportSize,
  textLayoutScale: number | undefined,
): ViewportSize {
  const scale =
    Number.isFinite(textLayoutScale) && Number(textLayoutScale) > 0
      ? Number(textLayoutScale)
      : 1;
  return {
    width: Math.max(MIN_INNER_SIZE_PX, stageSize.width / scale),
    height: Math.max(MIN_INNER_SIZE_PX, stageSize.height / scale),
  };
}

export function resolveBlockRectPx(
  block: TranslationBlock,
  pageSize: ViewportSize,
  stageSize: ViewportSize,
  text = "",
): PixelRect {
  const renderBbox = text.trim()
    ? resolveEffectiveRenderBbox(block, pageSize, text)
    : resolveBlockRenderBbox(block, pageSize);
  const pixelRect = bboxToPixels(renderBbox, pageSize.width, pageSize.height);
  const scaleX = stageSize.width / Math.max(1, pageSize.width);
  const scaleY = stageSize.height / Math.max(1, pageSize.height);

  return {
    left: pixelRect.x * scaleX,
    top: pixelRect.y * scaleY,
    width: pixelRect.w * scaleX,
    height: pixelRect.h * scaleY,
  };
}

export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

function resolveTextFontSizePx(
  block: TranslationBlock,
  text: string,
  maxFontSize: number,
  innerWidth: number,
  innerHeight: number,
): number {
  const capped = Math.max(MIN_FONT_SIZE_PX, Math.floor(maxFontSize));
  if (!(block.autoFitText ?? true) || !text.trim()) {
    return capped;
  }

  let low = MIN_FONT_SIZE_PX;
  let high = capped;
  let best = MIN_FONT_SIZE_PX;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (doesTextFit(block, text, mid, innerWidth, innerHeight)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.min(best, capped);
}

function doesTextFit(
  block: TranslationBlock,
  text: string,
  fontSize: number,
  innerWidth: number,
  innerHeight: number,
): boolean {
  const letterSpacingPx = resolveLetterSpacingPx(block, fontSize);
  const scaleX = resolveFontWidthScale(block.fontWidthScale);
  const { runs, plainText } = parseRichText(
    text,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  if (
    normalizeRenderDirection(block.renderDirection, "horizontal") === "vertical"
  ) {
    // Vertical advance is style-independent, so the marker-free text length is
    // what matters for column counting.
    return measureVerticalText(
      plainText,
      fontSize,
      innerWidth,
      innerHeight,
      fontSize * block.lineHeight + letterSpacingPx,
      scaleX,
    ).fits;
  }

  // 장평 squeezes/expands glyphs horizontally, so the usable measurement width
  // is the box width divided by the scale; wrapped widths are then scaled back.
  const effectiveWidth = innerWidth / scaleX;
  const context = getMeasureContext();
  const measured = measureStyledWrappedText(
    context,
    runs,
    effectiveWidth,
    fontSize * block.lineHeight,
    fontSize,
    resolveBlockFontFamily(block.fontFamily),
    letterSpacingPx,
  );
  return (
    measured.totalHeight <= innerHeight &&
    measured.maxLineWidth <= effectiveWidth
  );
}

function resolveLetterSpacingPx(
  block: TranslationBlock,
  fontSize: number,
): number {
  const em = block.letterSpacing;
  if (!em || !Number.isFinite(em)) {
    return 0;
  }
  return em * fontSize;
}

function resolveAutoFitUpperBound(
  block: TranslationBlock,
  preferredFontSize: number,
  innerWidth: number,
  innerHeight: number,
): number {
  if (!(block.autoFitText ?? true)) {
    return preferredFontSize;
  }

  const heightBound = Math.floor(
    innerHeight / Math.max(1, block.lineHeight || 1),
  );
  const scaleX = resolveFontWidthScale(block.fontWidthScale);
  const widthBound =
    normalizeRenderDirection(block.renderDirection, "horizontal") === "vertical"
      ? Math.floor(innerWidth / (1.15 * scaleX))
      : MAX_AUTOFIT_FONT_SIZE_PX;
  return clamp(
    Math.max(MIN_FONT_SIZE_PX, heightBound, widthBound),
    MIN_FONT_SIZE_PX,
    MAX_AUTOFIT_FONT_SIZE_PX,
  );
}

function measureVerticalText(
  text: string,
  fontSize: number,
  maxWidth: number,
  maxHeight: number,
  lineHeight: number,
  fontWidthScale = 1,
): { columnCount: number; fits: boolean } {
  if (!text.trim()) {
    return { columnCount: 0, fits: true };
  }

  const verticalSlots = [...text.replace(/\r/g, "").replace(/\n/g, " ")];
  const charsPerColumn = Math.max(
    1,
    Math.floor(maxHeight / Math.max(fontSize, lineHeight)),
  );
  const columnCount = Math.max(
    1,
    Math.ceil(verticalSlots.length / charsPerColumn),
  );
  const estimatedColumnWidth = fontSize * 1.15 * fontWidthScale;
  return {
    columnCount,
    fits:
      columnCount <= MAX_VERTICAL_COLUMNS &&
      columnCount * estimatedColumnWidth <= maxWidth,
  };
}

function getMeasureContext(): CanvasRenderingContext2D {
  if (typeof document === "undefined") {
    throw new Error("Document is not available for canvas text measurement");
  }

  measureCanvas ??= document.createElement("canvas");
  const context = measureCanvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context is not available");
  }
  return context;
}
