/* eslint-disable max-lines -- one wrapping module owns the shared styled-grapheme measurement and line-break contract */
import type { TextStyleRun } from "../../../shared/richTextMarkup";
import {
  allowsLongTokenFallback,
  keepsWordsTogether,
  resolveTextWordBreak,
  type TextWordBreak,
} from "../../../shared/textWrapping";
import {
  resolveNaturalWordBreakOffsets,
  segmentGraphemes,
  shouldBreakNaturally,
} from "./overlayTextSegmentation";
import type {
  TextRunRenderStyle,
  TextRunStyleResolver,
} from "./textStyleRunResolution";

type RenderedTextStyleRun = TextStyleRun & {
  renderedFontSizePx?: number;
  renderedFontFamily?: string;
  renderedOpacity?: number;
};

export type BlockTextLine = {
  runs: RenderedTextStyleRun[];
  width: number;
  slot?: TextLineSlot;
};

export type TextLineSlot = {
  /** Block-axis position: line top for horizontal, column left for vertical. */
  blockOffsetPx: number;
  /** Inline-axis position: line left for horizontal, column top for vertical. */
  inlineOffsetPx: number;
  /** Inline-axis room available after any applicable font-width scaling. */
  availableWidth: number;
  regionIndex: number;
};

export type WrappedTextMeasurement = {
  lines: BlockTextLine[];
  lineCount: number;
  totalHeight: number;
  maxLineWidth: number;
};

export type StyledGrapheme = {
  text: string;
  bold: boolean;
  italic: boolean;
  verticalCombine?: boolean;
  width: number;
  renderedFontSizePx?: number;
  renderedFontFamily?: string;
  renderedOpacity?: number;
};

export type TextMeasurementContext = Pick<
  CanvasRenderingContext2D,
  "font" | "measureText"
>;

/**
 * Measure and deterministically wrap rich text. The returned lines are also
 * rendered verbatim, which keeps editor layout independent from browser zoom.
 */
export function measureStyledWrappedText(
  context: TextMeasurementContext,
  runs: TextStyleRun[],
  maxWidth: number,
  lineHeightPx: number,
  fontSize: number,
  fontFamily: string,
  letterSpacingPx: number,
  wordBreak: TextWordBreak,
  resolveRunStyle?: TextRunStyleResolver,
): WrappedTextMeasurement {
  const graphemes = measureStyledGraphemes(
    context,
    runs,
    fontSize,
    fontFamily,
    resolveRunStyle,
  );
  const effectiveLineHeightPx = resolveEffectiveLineHeightPx(
    graphemes,
    lineHeightPx,
    fontSize,
  );
  return measureWrappedGraphemes(
    graphemes,
    maxWidth,
    effectiveLineHeightPx,
    letterSpacingPx,
    resolveTextWordBreak(wordBreak),
  );
}

export function measureUniformStyledWrappedText(
  runs: TextStyleRun[],
  maxWidth: number,
  lineHeightPx: number,
  graphemeAdvancePx: number,
  wordBreak: TextWordBreak,
  resolveGraphemeAdvancePx?: (
    grapheme: string,
    style: TextRunRenderStyle,
  ) => number,
  resolveRunStyle?: TextRunStyleResolver,
  segmentText?: (text: string, run: TextStyleRun) => string[],
): WrappedTextMeasurement {
  const graphemes = measureUniformStyledGraphemes(
    runs,
    graphemeAdvancePx,
    resolveGraphemeAdvancePx,
    resolveRunStyle,
    segmentText,
  );
  return measureWrappedGraphemes(
    graphemes,
    maxWidth,
    lineHeightPx,
    0,
    resolveTextWordBreak(wordBreak),
  );
}

// eslint-disable-next-line complexity -- run-boundary traversal and styled grapheme measurement must stay in one ordered pass
export function measureStyledGraphemes(
  context: TextMeasurementContext,
  runs: TextStyleRun[],
  fontSize: number,
  fontFamily: string,
  resolveRunStyle?: TextRunStyleResolver,
): StyledGrapheme[] {
  const normalizedRuns = runs.map((run) => ({
    ...run,
    text: normalizeNewlines(run.text),
  }));
  const combinedText = normalizedRuns.map((run) => run.text).join("");
  const graphemes: StyledGrapheme[] = [];
  let runIndex = 0;
  let runEnd = normalizedRuns[0]?.text.length ?? 0;
  let textOffset = 0;
  for (const segment of segmentGraphemes(combinedText)) {
    while (runIndex < normalizedRuns.length - 1 && textOffset >= runEnd) {
      runIndex += 1;
      runEnd += normalizedRuns[runIndex]?.text.length ?? 0;
    }
    const run = normalizedRuns[runIndex] ?? {
      text: "",
      bold: false,
      italic: false,
    };
    const style = resolveRunStyle?.(run) ?? {
      fontSizePx: fontSize,
      fontFamily,
      opacity: 1,
    };
    context.font = buildFontForStyle(
      style.fontSizePx,
      style.fontFamily,
      run.bold,
      run.italic,
    );
    graphemes.push({
      text: segment,
      bold: run.bold,
      italic: run.italic,
      ...(run.verticalCombine ? { verticalCombine: true } : {}),
      width: segment === "\n" ? 0 : context.measureText(segment).width,
      ...(resolveRunStyle
        ? {
            renderedFontSizePx: style.fontSizePx,
            renderedFontFamily: style.fontFamily,
            renderedOpacity: style.opacity,
          }
        : {}),
    });
    textOffset += segment.length;
  }
  return graphemes;
}

export function measureUniformStyledGraphemes(
  runs: TextStyleRun[],
  graphemeAdvancePx: number,
  resolveGraphemeAdvancePx?: (
    grapheme: string,
    style: TextRunRenderStyle,
  ) => number,
  resolveRunStyle?: TextRunStyleResolver,
  segmentText: (text: string, run: TextStyleRun) => string[] = segmentGraphemes,
): StyledGrapheme[] {
  return runs.flatMap((run) => {
    const style = resolveRunStyle?.(run) ?? {
      fontSizePx: graphemeAdvancePx,
      fontFamily: "sans-serif",
      opacity: 1,
    };
    return segmentText(normalizeNewlines(run.text), run).map((text) => ({
      text,
      bold: run.bold,
      italic: run.italic,
      ...(run.verticalCombine ? { verticalCombine: true } : {}),
      width:
        text === "\n"
          ? 0
          : (resolveGraphemeAdvancePx?.(text, style) ?? graphemeAdvancePx),
      ...(resolveRunStyle
        ? {
            renderedFontSizePx: style.fontSizePx,
            renderedFontFamily: style.fontFamily,
            renderedOpacity: style.opacity,
          }
        : {}),
    }));
  });
}

function measureWrappedGraphemes(
  graphemes: StyledGrapheme[],
  maxWidth: number,
  lineHeightPx: number,
  letterSpacingPx: number,
  wordBreak: TextWordBreak,
): WrappedTextMeasurement {
  const lines: BlockTextLine[] = [];
  let paragraph: StyledGrapheme[] = [];

  const flushParagraph = (): void => {
    lines.push(
      ...wrapParagraph(paragraph, maxWidth, letterSpacingPx, wordBreak),
    );
    paragraph = [];
  };

  for (const grapheme of graphemes) {
    if (grapheme.text === "\n") {
      flushParagraph();
    } else {
      paragraph.push(grapheme);
    }
  }
  flushParagraph();

  const maxLineWidth = lines.reduce(
    (largest, line) => Math.max(largest, line.width),
    0,
  );
  return {
    lines,
    lineCount: lines.length,
    totalHeight: lines.length * lineHeightPx,
    maxLineWidth,
  };
}

function wrapParagraph(
  graphemes: StyledGrapheme[],
  maxWidth: number,
  letterSpacingPx: number,
  wordBreak: TextWordBreak,
): BlockTextLine[] {
  if (graphemes.length === 0) {
    return [{ runs: [], width: 0 }];
  }
  if (wordBreak === "break-all") {
    return wrapEagerly(graphemes, maxWidth, letterSpacingPx);
  }

  const units = buildNaturalUnits(graphemes, !keepsWordsTogether(wordBreak));
  return wrapNaturalUnits(
    units,
    maxWidth,
    letterSpacingPx,
    allowsLongTokenFallback(wordBreak),
  );
}

function wrapNaturalUnits(
  units: StyledGrapheme[][],
  maxWidth: number,
  letterSpacingPx: number,
  emergencyBreak: boolean,
): BlockTextLine[] {
  const lines: BlockTextLine[] = [];
  let line: StyledGrapheme[] = [];
  let lineWidth = 0;

  const pushLine = (): void => {
    lines.push(toBlockTextLine(line, lineWidth));
    line = [];
    lineWidth = 0;
  };

  for (const unit of units) {
    const unitWidth = measureGraphemeSequence(unit, letterSpacingPx);
    const combinedWidth =
      lineWidth + (line.length > 0 ? letterSpacingPx : 0) + unitWidth;
    if (line.length > 0 && combinedWidth > maxWidth) {
      pushLine();
    }

    if (emergencyBreak && unitWidth > maxWidth) {
      const emergencyLines = wrapEagerly(unit, maxWidth, letterSpacingPx);
      lines.push(...emergencyLines.slice(0, -1));
      const finalLine = emergencyLines.at(-1);
      line = finalLine ? lineFromRuns(finalLine.runs, unit) : [];
      lineWidth = finalLine?.width ?? 0;
      continue;
    }

    if (line.length > 0) {
      lineWidth += letterSpacingPx;
    }
    line.push(...unit);
    lineWidth += unitWidth;
  }
  pushLine();
  return lines;
}

function wrapEagerly(
  graphemes: StyledGrapheme[],
  maxWidth: number,
  letterSpacingPx: number,
): BlockTextLine[] {
  const lines: BlockTextLine[] = [];
  let line: StyledGrapheme[] = [];
  let lineWidth = 0;

  const pushLine = (): void => {
    lines.push(toBlockTextLine(line, lineWidth));
    line = [];
    lineWidth = 0;
  };

  for (const grapheme of graphemes) {
    const advance = grapheme.width + (line.length > 0 ? letterSpacingPx : 0);
    if (line.length > 0 && lineWidth + advance > maxWidth) {
      pushLine();
    }
    if (line.length > 0) {
      lineWidth += letterSpacingPx;
    }
    line.push(grapheme);
    lineWidth += grapheme.width;
  }
  pushLine();
  return lines;
}

export function buildNaturalUnits(
  graphemes: StyledGrapheme[],
  allowCjkBreaks: boolean,
): StyledGrapheme[][] {
  const units: StyledGrapheme[][] = [];
  const wordBreakOffsets = resolveNaturalWordBreakOffsets(graphemes);
  let unit: StyledGrapheme[] = [];
  let textOffset = 0;
  for (const grapheme of graphemes) {
    const previous = unit.at(-1);
    if (
      previous &&
      shouldBreakNaturally(
        previous.text,
        grapheme.text,
        allowCjkBreaks,
        wordBreakOffsets.has(textOffset),
      )
    ) {
      units.push(unit);
      unit = [];
    }
    unit.push(grapheme);
    textOffset += grapheme.text.length;
  }
  if (unit.length > 0) {
    units.push(unit);
  }
  return units;
}

export function measureGraphemeSequence(
  graphemes: StyledGrapheme[],
  letterSpacingPx: number,
): number {
  return graphemes.reduce(
    (width, grapheme, index) =>
      width + grapheme.width + (index > 0 ? letterSpacingPx : 0),
    0,
  );
}

export function toBlockTextLine(
  graphemes: StyledGrapheme[],
  width: number,
): BlockTextLine {
  const runs: RenderedTextStyleRun[] = [];
  for (const grapheme of graphemes) {
    const lastRun = runs.at(-1);
    if (
      lastRun &&
      lastRun.bold === grapheme.bold &&
      lastRun.italic === grapheme.italic &&
      lastRun.verticalCombine === grapheme.verticalCombine &&
      lastRun.renderedFontSizePx === grapheme.renderedFontSizePx &&
      lastRun.renderedFontFamily === grapheme.renderedFontFamily &&
      lastRun.renderedOpacity === grapheme.renderedOpacity
    ) {
      lastRun.text += grapheme.text;
    } else {
      runs.push(createRenderedTextStyleRun(grapheme));
    }
  }
  return { runs, width };
}

function createRenderedTextStyleRun(
  grapheme: StyledGrapheme,
): RenderedTextStyleRun {
  return {
    text: grapheme.text,
    bold: grapheme.bold,
    italic: grapheme.italic,
    ...(grapheme.verticalCombine ? { verticalCombine: true } : {}),
    ...(grapheme.renderedFontSizePx === undefined
      ? {}
      : { renderedFontSizePx: grapheme.renderedFontSizePx }),
    ...(grapheme.renderedFontFamily === undefined
      ? {}
      : { renderedFontFamily: grapheme.renderedFontFamily }),
    ...(grapheme.renderedOpacity === undefined
      ? {}
      : { renderedOpacity: grapheme.renderedOpacity }),
  };
}

function lineFromRuns(
  runs: RenderedTextStyleRun[],
  candidates: StyledGrapheme[],
): StyledGrapheme[] {
  const textLength = runs.reduce((total, run) => total + run.text.length, 0);
  let recoveredLength = 0;
  let start = candidates.length;
  while (start > 0 && recoveredLength < textLength) {
    start -= 1;
    recoveredLength += candidates[start]?.text.length ?? 0;
  }
  return candidates.slice(start);
}

function resolveEffectiveLineHeightPx(
  graphemes: readonly StyledGrapheme[],
  baseLineHeightPx: number,
  baseFontSizePx: number,
): number {
  const maximumFontSizePx = graphemes.reduce(
    (largest, grapheme) =>
      Math.max(largest, grapheme.renderedFontSizePx ?? baseFontSizePx),
    baseFontSizePx,
  );
  return (
    baseLineHeightPx *
    (maximumFontSizePx / Math.max(Number.EPSILON, baseFontSizePx))
  );
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function buildFontForStyle(
  fontSize: number,
  fontFamily: string,
  bold: boolean,
  italic: boolean,
): string {
  const style = italic ? "italic " : "";
  const weight = bold ? 800 : 400;
  return `${style}${weight} ${fontSize}px ${fontFamily}`;
}
