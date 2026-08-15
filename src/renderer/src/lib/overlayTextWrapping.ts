import type { TextStyleRun } from "../../../shared/richTextMarkup";
import {
  resolveTextWordBreak,
  type TextWordBreak,
} from "../../../shared/textWrapping";
import {
  resolveNaturalWordBreakOffsets,
  segmentGraphemes,
  shouldBreakNaturally,
} from "./overlayTextSegmentation";

export type BlockTextLine = {
  runs: TextStyleRun[];
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
  width: number;
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
): WrappedTextMeasurement {
  const graphemes = measureStyledGraphemes(context, runs, fontSize, fontFamily);
  return measureWrappedGraphemes(
    graphemes,
    maxWidth,
    lineHeightPx,
    letterSpacingPx,
    resolveTextWordBreak(wordBreak),
  );
}

/**
 * Vertical text uses a uniform inline-axis advance. Reusing the same break
 * policy here keeps auto-fit/overflow decisions aligned with vertical CSS.
 */
export function measureUniformWrappedText(
  text: string,
  maxWidth: number,
  lineHeightPx: number,
  graphemeAdvancePx: number,
  wordBreak: TextWordBreak,
  resolveGraphemeAdvancePx?: (grapheme: string) => number,
): WrappedTextMeasurement {
  const graphemes = segmentGraphemes(normalizeNewlines(text)).map((value) => ({
    text: value,
    bold: false,
    italic: false,
    width:
      value === "\n"
        ? 0
        : (resolveGraphemeAdvancePx?.(value) ?? graphemeAdvancePx),
  }));
  return measureWrappedGraphemes(
    graphemes,
    maxWidth,
    lineHeightPx,
    0,
    resolveTextWordBreak(wordBreak),
  );
}

export function measureStyledGraphemes(
  context: TextMeasurementContext,
  runs: TextStyleRun[],
  fontSize: number,
  fontFamily: string,
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
    context.font = buildFontForStyle(
      fontSize,
      fontFamily,
      run.bold,
      run.italic,
    );
    graphemes.push({
      text: segment,
      bold: run.bold,
      italic: run.italic,
      width: segment === "\n" ? 0 : context.measureText(segment).width,
    });
    textOffset += segment.length;
  }
  return graphemes;
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

  const units = buildNaturalUnits(graphemes, wordBreak !== "keep-all");
  return wrapNaturalUnits(
    units,
    maxWidth,
    letterSpacingPx,
    wordBreak === "break-word",
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
  const runs: TextStyleRun[] = [];
  for (const grapheme of graphemes) {
    const lastRun = runs.at(-1);
    if (
      lastRun &&
      lastRun.bold === grapheme.bold &&
      lastRun.italic === grapheme.italic
    ) {
      lastRun.text += grapheme.text;
    } else {
      runs.push({
        text: grapheme.text,
        bold: grapheme.bold,
        italic: grapheme.italic,
      });
    }
  }
  return { runs, width };
}

function lineFromRuns(
  runs: TextStyleRun[],
  candidates: StyledGrapheme[],
): StyledGrapheme[] {
  const count = runs.reduce(
    (total, run) => total + segmentGraphemes(run.text).length,
    0,
  );
  return candidates.slice(Math.max(0, candidates.length - count));
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
