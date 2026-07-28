import { resolveFontWidthScale } from "./geometry";
import { isUsableBubbleLayout } from "./bubbleLayout";
import type { TranslationBlock } from "./textTypes";
import {
  cjkRatio,
  isCjkGrapheme,
  isEmojiGrapheme,
  isNaturalPunctuation,
  isNaturalWhitespace,
  isSemanticNaturalGrapheme,
  normalizeParagraphWhitespace,
  segmentNaturalTextGraphemes,
  segmentNaturalTextWords,
} from "./naturalTextLayoutSegmentation";

export type NaturalWrapMode = "word" | "grapheme";

export type NaturalTextMetrics = {
  fontSizePx: number;
  fontWidthScale: number;
  letterSpacingPx: number;
  bold: boolean;
  italic: boolean;
};

export type NaturalVerticalDecision = {
  eligible: boolean;
  oneColumnMaxFontPx?: number;
  twoColumnMaxFontPx?: number;
};

export type NaturalVerticalOptions = {
  allowAutoVertical?: boolean;
  directionPreference?: "auto" | "horizontal" | "vertical";
};

const MIN_READABLE_FONT_SIZE_PX = 10;
const WORD_MODE_MIN_WORDS_PER_LINE = 1.5;
const VERTICAL_MIN_ASPECT_RATIO = 6;
const VERTICAL_COLUMN_WIDTH_RATIO = 1.15;
const VERTICAL_MAX_PREFERRED_WIDTH_CAPACITY = 1.3;
const VERTICAL_MIN_PREFERRED_FONT_RATIO = 0.95;
const VERTICAL_MIN_READABLE_FONT_SIZE_PX = 16;
const VERTICAL_ONE_COLUMN_ADVANTAGE_RATIO = 1.35;
const VERTICAL_MAX_AUTO_GLYPHS = 10;

export function resolveNaturalTextMetrics(
  block: TranslationBlock,
): NaturalTextMetrics {
  const fontSizePx = Math.max(
    MIN_READABLE_FONT_SIZE_PX,
    Number.isFinite(block.fontSizePx) ? block.fontSizePx : 16,
  );
  return {
    fontSizePx,
    fontWidthScale: resolveFontWidthScale(block.fontWidthScale),
    letterSpacingPx: (block.letterSpacing ?? 0) * fontSizePx,
    bold: Boolean(block.bold),
    italic: Boolean(block.italic),
  };
}

export function measureNaturalText(
  value: string,
  metrics: NaturalTextMetrics,
): number {
  const graphemes = segmentNaturalTextGraphemes(value);
  return measureNaturalGraphemeSlice(graphemes, 0, graphemes.length, metrics);
}

export function measureNaturalGraphemeSlice(
  graphemes: string[],
  start: number,
  end: number,
  metrics: NaturalTextMetrics,
): number {
  let width = 0;
  for (let index = start; index < end; index += 1) {
    if (index > start) width += metrics.letterSpacingPx;
    width += approximateGraphemeEm(graphemes[index]) * metrics.fontSizePx;
  }
  const styleScale = (metrics.bold ? 1.06 : 1) * (metrics.italic ? 1.02 : 1);
  return width * styleScale;
}

export function resolveNaturalWrapMode(
  text: string,
  maxWidth: number,
  metrics: NaturalTextMetrics,
  locale?: string,
): { mode: NaturalWrapMode; estimatedWordsPerLine: number } {
  const normalized = normalizeParagraphWhitespace(
    text.replace(/\r\n?/gu, "\n").replace(/\n/gu, " "),
  );
  const widths = segmentNaturalTextWords(normalized, locale)
    .filter((entry) => entry.isWordLike)
    .map((entry) => measureNaturalText(entry.segment, metrics))
    .filter((width) => width > 0)
    .sort((left, right) => left - right);
  const medianWordWidth =
    widths.at(Math.floor(widths.length / 2)) ??
    measureNaturalText(
      segmentNaturalTextGraphemes(normalized)[0] ?? "",
      metrics,
    );
  const estimatedWordsPerLine =
    maxWidth / Math.max(1, medianWordWidth + measureNaturalText(" ", metrics));
  return {
    mode:
      widths.length >= 2 &&
      estimatedWordsPerLine >= WORD_MODE_MIN_WORDS_PER_LINE
        ? "word"
        : "grapheme",
    estimatedWordsPerLine,
  };
}

export function resizeNaturalTextMetrics(
  metrics: NaturalTextMetrics,
  fontSizePx: number,
): NaturalTextMetrics {
  const nextFontSize = Math.max(0.01, fontSizePx);
  return {
    ...metrics,
    fontSizePx: nextFontSize,
    letterSpacingPx:
      (metrics.letterSpacingPx / Math.max(0.01, metrics.fontSizePx)) *
      nextFontSize,
  };
}

export function resolveNaturalVerticalDecision(
  block: TranslationBlock,
  text: string,
  rect: { w: number; h: number },
  options: NaturalVerticalOptions,
): NaturalVerticalDecision {
  if (!canConsiderVertical(block, text, options)) {
    return { eligible: false };
  }
  const graphemes = segmentNaturalTextGraphemes(text).filter(
    (value) => value !== "\r" && value !== "\n",
  );
  const visible = graphemes.filter(isSemanticNaturalGrapheme);
  if (!hasVerticalShapeAndScript(block, rect, visible)) {
    return { eligible: false };
  }
  return compareVerticalColumnFits(block, rect, graphemes.length);
}

function canConsiderVertical(
  block: TranslationBlock,
  text: string,
  options: NaturalVerticalOptions,
): boolean {
  return Boolean(
    options.allowAutoVertical &&
    (options.directionPreference ?? "auto") === "auto" &&
    block.renderDirection !== "vertical" &&
    !text.includes("\n") &&
    !block.curveLayout &&
    !isHorizontalBubbleLayout(block),
  );
}

function isHorizontalBubbleLayout(block: TranslationBlock): boolean {
  return (
    isUsableBubbleLayout(block.bubbleLayout) &&
    block.bubbleLayout.direction === "horizontal"
  );
}

function hasVerticalShapeAndScript(
  block: TranslationBlock,
  rect: { w: number; h: number },
  visible: string[],
): boolean {
  if (
    block.sourceDirection !== "vertical" ||
    visible.length < 2 ||
    visible.length > VERTICAL_MAX_AUTO_GLYPHS ||
    cjkRatio(visible) < 0.9
  ) {
    return false;
  }
  const metrics = resolveNaturalTextMetrics(block);
  const aspectRatio = rect.h / Math.max(1, rect.w);
  const widthCapacity =
    rect.w / Math.max(1, metrics.fontSizePx * metrics.fontWidthScale);
  return (
    aspectRatio >= VERTICAL_MIN_ASPECT_RATIO &&
    widthCapacity <= VERTICAL_MAX_PREFERRED_WIDTH_CAPACITY
  );
}

function compareVerticalColumnFits(
  block: TranslationBlock,
  rect: { w: number; h: number },
  glyphCount: number,
): NaturalVerticalDecision {
  const metrics = resolveNaturalTextMetrics(block);
  const advanceFactor = Math.max(
    1,
    Math.max(1, block.lineHeight || 1.18) + (block.letterSpacing ?? 0),
  );
  const oneColumnMaxFontPx = maxVerticalFontForColumns(
    rect,
    metrics.fontWidthScale,
    glyphCount,
    advanceFactor,
    1,
  );
  const twoColumnMaxFontPx = maxVerticalFontForColumns(
    rect,
    metrics.fontWidthScale,
    glyphCount,
    advanceFactor,
    2,
  );
  const eligible =
    (block.autoFitText ?? true)
      ? oneColumnMaxFontPx >=
          Math.max(
            VERTICAL_MIN_READABLE_FONT_SIZE_PX,
            metrics.fontSizePx * VERTICAL_MIN_PREFERRED_FONT_RATIO,
          ) &&
        oneColumnMaxFontPx >=
          twoColumnMaxFontPx * VERTICAL_ONE_COLUMN_ADVANTAGE_RATIO
      : fixedFontFitsOneColumn(rect, metrics, glyphCount, advanceFactor);
  return {
    eligible,
    oneColumnMaxFontPx: roundNaturalMetric(oneColumnMaxFontPx),
    twoColumnMaxFontPx: roundNaturalMetric(twoColumnMaxFontPx),
  };
}

function maxVerticalFontForColumns(
  rect: { w: number; h: number },
  fontWidthScale: number,
  glyphCount: number,
  advanceFactor: number,
  columns: 1 | 2,
): number {
  const widthLimited =
    rect.w /
    (columns * VERTICAL_COLUMN_WIDTH_RATIO * Math.max(0.01, fontWidthScale));
  const heightLimited =
    rect.h / (Math.ceil(glyphCount / columns) * advanceFactor);
  return Math.min(widthLimited, heightLimited);
}

function fixedFontFitsOneColumn(
  rect: { w: number; h: number },
  metrics: NaturalTextMetrics,
  glyphCount: number,
  advanceFactor: number,
): boolean {
  return (
    glyphCount * metrics.fontSizePx * advanceFactor <= rect.h &&
    metrics.fontSizePx * VERTICAL_COLUMN_WIDTH_RATIO * metrics.fontWidthScale <=
      rect.w
  );
}

function approximateGraphemeEm(value: string): number {
  if (isNaturalWhitespace(value)) return 0.33;
  if (isCjkGrapheme(value) || isEmojiGrapheme(value)) return 1;
  if (/^\p{Mark}+$/u.test(value)) return 0;
  if (/^[A-Z]$/u.test(value)) return 0.66;
  if (/^[a-z0-9]$/u.test(value)) return 0.55;
  if (isNaturalPunctuation(value)) return 0.42;
  return 0.78;
}

export function roundNaturalMetric(value: number): number {
  return Math.round(value * 100) / 100;
}
