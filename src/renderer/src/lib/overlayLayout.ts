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
import { resolveBlockFontFamily } from "./fonts";

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
  innerWidth: number;
  innerHeight: number;
  fitInnerWidth: number;
  fitInnerHeight: number;
  fontSizePx: number;
  overflow: boolean;
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
): BlockTextLayout {
  const rect = resolveBlockRectPx(block, pageSize, stageSize, text);
  const paddingPx = resolveBlockPaddingPx(rect);
  // The text layer is borderless and fills the block (inset: 0), so the usable
  // box is the full rect. The PNG exporter uses the same full-rect box model.
  const innerWidth = Math.max(MIN_INNER_SIZE_PX, rect.width - paddingPx * 2);
  const innerHeight = Math.max(MIN_INNER_SIZE_PX, rect.height - paddingPx * 2);
  const fitInnerWidth = innerWidth;
  const fitInnerHeight = innerHeight;
  const scale = Math.min(
    stageSize.width / Math.max(1, pageSize.width),
    stageSize.height / Math.max(1, pageSize.height),
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

  return {
    rect,
    paddingPx,
    innerWidth,
    innerHeight,
    fitInnerWidth,
    fitInnerHeight,
    fontSizePx,
    overflow: text.trim()
      ? !doesTextFit(block, text, fontSizePx, fitInnerWidth, fitInnerHeight)
      : false,
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
  if (
    normalizeRenderDirection(block.renderDirection, "horizontal") === "vertical"
  ) {
    return measureVerticalText(
      text,
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
  context.font = buildFont(fontSize, block);
  applyLetterSpacing(context, letterSpacingPx);
  const measured = measureWrappedText(
    context,
    text,
    effectiveWidth,
    fontSize * block.lineHeight,
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

function applyLetterSpacing(
  context: CanvasRenderingContext2D,
  px: number,
): void {
  (
    context as CanvasRenderingContext2D & { letterSpacing?: string }
  ).letterSpacing = `${px}px`;
}

function wrapTextToWidth(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const paragraphs = text.replace(/\r/g, "").split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const char of [...paragraph]) {
      const candidate = `${current}${char}`;
      if (!current || context.measureText(candidate).width <= maxWidth) {
        current = candidate;
        continue;
      }

      lines.push(current);
      current = char;
    }

    if (current) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : [text];
}

function measureWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  lineHeight: number,
): { lines: string[]; totalHeight: number; maxLineWidth: number } {
  const lines = wrapTextToWidth(context, text, maxWidth);
  return {
    lines,
    totalHeight: lines.length * lineHeight,
    maxLineWidth: lines.reduce(
      (widest, line) => Math.max(widest, context.measureText(line).width),
      0,
    ),
  };
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

function buildFont(fontSize: number, block: TranslationBlock): string {
  const style = block.italic ? "italic " : "";
  const weight = block.bold ? 800 : 400;
  return `${style}${weight} ${fontSize}px ${resolveBlockFontFamily(block.fontFamily)}`;
}
