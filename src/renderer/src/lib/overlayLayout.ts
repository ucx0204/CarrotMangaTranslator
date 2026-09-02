import type { TranslationBlock } from "../../../shared/textTypes";
import { MIN_READABLE_FONT_SIZE_PX } from "../../../shared/readableTextBox";
import {
  bboxToPixels,
  clamp,
  normalizeRenderDirection,
  resolveBlockRenderBbox,
  resolveEffectiveRenderBbox,
  resolveFontWidthScale,
} from "../../../shared/geometry";
import { parseRichText } from "../../../shared/richTextMarkup";
import type { BlockFontCatalog } from "./fonts";
import {
  doesBlockTextFit as doesTextFit,
  resolveFixedHorizontalTextLines,
  resolveHorizontalTextContentWidth,
} from "./blockTextMeasurement";
import { resolveBubbleWrappedText } from "./bubbleBlockTextLayout";
import { type BlockTextLine } from "./overlayTextWrapping";
import { resolveSourceMatchedFontSizeCapPx } from "./sourceFontSizeMatching";

const MIN_FONT_SIZE_PX = MIN_READABLE_FONT_SIZE_PX;
const MAX_AUTOFIT_FONT_SIZE_PX = 256;
const MIN_INNER_SIZE_PX = 1;

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
  sourceFontFaceFallbackPx?: number;
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
  fontCatalog: BlockFontCatalog,
  options: BlockTextLayoutOptions = {},
): BlockTextLayout {
  return resolveBlockTextLayoutCore(
    block,
    text,
    pageSize,
    stageSize,
    fontCatalog,
    options,
  );
}

function resolveBlockTextLayoutCore(
  block: TranslationBlock,
  text: string,
  pageSize: ViewportSize,
  stageSize: ViewportSize,
  fontCatalog: BlockFontCatalog,
  options: BlockTextLayoutOptions,
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
  const textMetrics = resolveBlockTextMetrics({
    block,
    text,
    fitInnerWidth,
    fitInnerHeight,
    fontCatalog,
    layoutStageSize,
    pageSize,
    sourceFontFaceFallbackPx: options.sourceFontFaceFallbackPx,
  });

  return {
    rect,
    paddingPx,
    layoutWidth,
    layoutHeight,
    innerWidth,
    innerHeight,
    fitInnerWidth,
    fitInnerHeight,
    ...textMetrics,
    textScaleX: rect.width / layoutWidth,
    textScaleY: rect.height / layoutHeight,
  };
}

type TextMetricsInput = {
  block: TranslationBlock;
  text: string;
  fitInnerWidth: number;
  fitInnerHeight: number;
  fontCatalog: BlockFontCatalog;
  layoutStageSize: ViewportSize;
  pageSize: ViewportSize;
  sourceFontFaceFallbackPx?: number;
};

type BubbleMeasurer = (
  fontSize: number,
) => ReturnType<typeof resolveBubbleWrappedText>;

function resolveBlockTextMetrics(
  input: TextMetricsInput,
): Pick<
  BlockTextLayout,
  "fontSizePx" | "textContentWidth" | "lines" | "overflow"
> {
  const {
    block,
    text,
    fitInnerWidth,
    fitInnerHeight,
    layoutStageSize,
    pageSize,
  } = input;
  const scale = Math.min(
    layoutStageSize.width / Math.max(1, pageSize.width),
    layoutStageSize.height / Math.max(1, pageSize.height),
  );
  const geometryFontSize = Math.max(MIN_FONT_SIZE_PX, block.fontSizePx * scale);
  const sourceMatchedCapPx = resolveSourceMatchedFontSizeCapPx(
    block,
    text,
    input.fontCatalog,
    pageSize,
    input.sourceFontFaceFallbackPx,
  );
  const preferredFontSize =
    block.fontSizeIntent === "source-match" &&
    Number.isFinite(sourceMatchedCapPx) &&
    Number(sourceMatchedCapPx) > 0
      ? Math.max(
          MIN_FONT_SIZE_PX,
          Math.floor(Number(sourceMatchedCapPx) * scale),
        )
      : geometryFontSize;
  const maxFontSize = resolveAutoFitUpperBound(
    block,
    preferredFontSize,
    fitInnerWidth,
    fitInnerHeight,
    scale,
    sourceMatchedCapPx,
  );
  const bubbleMeasurer = createBubbleMeasurer(input);
  const fontSizePx = resolveTextFontSizePx(
    block,
    text,
    maxFontSize,
    createFitsAtFontSize(input, bubbleMeasurer),
  );
  return resolveFinalTextMetrics(input, fontSizePx, bubbleMeasurer);
}

function createBubbleMeasurer(input: TextMetricsInput): BubbleMeasurer | null {
  const { block, text, fitInnerWidth, fitInnerHeight, fontCatalog } = input;
  if (!text.trim() || block.curveLayout) return null;
  const measure: BubbleMeasurer = (fontSize) =>
    resolveBubbleWrappedText(
      block,
      text,
      fontSize,
      fitInnerWidth,
      fitInnerHeight,
      fontCatalog,
    );
  return measure(MIN_FONT_SIZE_PX) ? measure : null;
}

function createFitsAtFontSize(
  input: TextMetricsInput,
  bubbleMeasurer: BubbleMeasurer | null,
): (fontSize: number) => boolean {
  if (bubbleMeasurer) {
    return (fontSize) => Boolean(bubbleMeasurer(fontSize));
  }
  const { block, text, fitInnerWidth, fitInnerHeight, fontCatalog } = input;
  return (fontSize) =>
    doesTextFit(
      block,
      text,
      fontSize,
      fitInnerWidth,
      fitInnerHeight,
      fontCatalog,
    );
}

function resolveFinalTextMetrics(
  input: TextMetricsInput,
  fontSizePx: number,
  bubbleMeasurer: BubbleMeasurer | null,
): Pick<
  BlockTextLayout,
  "fontSizePx" | "textContentWidth" | "lines" | "overflow"
> {
  const { block, text, fitInnerWidth, fitInnerHeight, fontCatalog } = input;
  const textContentWidth = resolveHorizontalTextContentWidth(
    block,
    fitInnerWidth,
  );
  const bubbleMeasurement = bubbleMeasurer?.(fontSizePx) ?? null;
  return {
    fontSizePx,
    textContentWidth,
    lines:
      bubbleMeasurement?.lines ??
      resolveFixedHorizontalTextLines(
        block,
        text,
        fontSizePx,
        textContentWidth,
        fontCatalog,
      ),
    overflow: bubbleMeasurement
      ? false
      : text.trim()
        ? !doesTextFit(
            block,
            text,
            fontSizePx,
            fitInnerWidth,
            fitInnerHeight,
            fontCatalog,
          )
        : false,
  };
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

function resolveTextFontSizePx(
  block: TranslationBlock,
  text: string,
  maxFontSize: number,
  fitsAtFontSize: (fontSize: number) => boolean,
): number {
  const bounded = Math.max(MIN_FONT_SIZE_PX, maxFontSize);
  if (!(block.autoFitText ?? true) || !text.trim()) {
    return bounded;
  }

  const capped = Math.floor(bounded);

  let low = MIN_FONT_SIZE_PX;
  let high = capped;
  let best = MIN_FONT_SIZE_PX;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fitsAtFontSize(mid)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.min(best, capped);
}

function resolveAutoFitUpperBound(
  block: TranslationBlock,
  preferredFontSize: number,
  innerWidth: number,
  innerHeight: number,
  layoutScale: number,
  sourceMatchedCapPx: number | null,
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
  const genericUpperBound = clamp(
    Math.max(MIN_FONT_SIZE_PX, heightBound, widthBound),
    MIN_FONT_SIZE_PX,
    MAX_AUTOFIT_FONT_SIZE_PX,
  );
  const roleBound =
    block.fontRole === "sign_ui_title"
      ? Math.min(genericUpperBound, preferredFontSize * 2)
      : genericUpperBound;
  if (!Number.isFinite(sourceMatchedCapPx) || Number(sourceMatchedCapPx) <= 0) {
    return roleBound;
  }
  return Math.min(
    roleBound,
    Math.max(
      MIN_FONT_SIZE_PX,
      Math.floor(Number(sourceMatchedCapPx) * layoutScale),
    ),
  );
}
