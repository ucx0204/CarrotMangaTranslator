import type { TextStyleRun } from "../../../shared/richTextMarkup";
import { isCjkGrapheme } from "../../../shared/naturalTextLayoutSegmentation";
import {
  allowsLongTokenFallback,
  keepsWordsTogether,
  resolveTextWordBreak,
  type TextWordBreak,
} from "../../../shared/textWrapping";
import {
  buildNaturalUnits,
  measureGraphemeSequence,
  measureStyledGraphemes,
  measureUniformStyledGraphemes,
  toBlockTextLine,
  type BlockTextLine,
  type StyledGrapheme,
  type TextLineSlot,
  type TextMeasurementContext,
  type WrappedTextMeasurement,
} from "./overlayTextWrapping";
import type {
  TextRunRenderStyle,
  TextRunStyleResolver,
} from "./textStyleRunResolution";
import {
  resolveNaturalWordBreakOffsets,
  segmentGraphemes,
} from "./overlayTextSegmentation";

export type SlottedWrappedTextMeasurement = WrappedTextMeasurement & {
  fits: boolean;
  consumedAll: boolean;
};

const WIDTH_EPSILON_PX = 1e-6;

export type WrappedTextQuality = {
  intraWordSplitCount: number;
  orphanLineCount: number;
  lineCount: number;
  semanticGraphemeCount: number;
  averageSemanticGraphemesPerLine: number;
};

/**
 * Measure rendered line damage without changing the text or wrapping policy.
 * Natural word boundaries and explicit source newlines are free; a boundary
 * inside a letter/number sequence is counted as an intra-word split.
 */
export function assessWrappedTextQuality(
  plainText: string,
  lines: readonly BlockTextLine[],
): WrappedTextQuality {
  const compact = compactExplicitNewlines(plainText.replace(/\r\n?/g, "\n"));
  const naturalBoundaries = resolveNaturalWordBreakOffsets(
    segmentGraphemes(compact.text).map((text) => ({ text })),
  );
  let textOffset = 0;
  let intraWordSplitCount = 0;
  let orphanLineCount = 0;
  let semanticGraphemeCount = 0;
  for (const [index, line] of lines.entries()) {
    const lineText = line.runs.map((run) => run.text).join("");
    textOffset += line.sourceTextLength ?? lineText.length;
    semanticGraphemeCount += countSemanticGraphemes(lineText);
    if (countContentGraphemes(lineText) === 1) {
      orphanLineCount += 1;
    }
    if (
      index < lines.length - 1 &&
      isDamagingWordBoundary(
        compact.text,
        textOffset,
        naturalBoundaries,
        compact.explicitBoundaries,
      )
    ) {
      intraWordSplitCount += 1;
    }
  }
  return {
    intraWordSplitCount,
    orphanLineCount,
    lineCount: lines.length,
    semanticGraphemeCount,
    averageSemanticGraphemesPerLine:
      semanticGraphemeCount / Math.max(1, lines.length),
  };
}

function compactExplicitNewlines(value: string): {
  text: string;
  explicitBoundaries: ReadonlySet<number>;
} {
  let text = "";
  const explicitBoundaries = new Set<number>();
  for (const grapheme of segmentGraphemes(value)) {
    if (grapheme === "\n") {
      explicitBoundaries.add(text.length);
    } else {
      text += grapheme;
    }
  }
  return { text, explicitBoundaries };
}

function isDamagingWordBoundary(
  text: string,
  offset: number,
  naturalBoundaries: ReadonlySet<number>,
  explicitBoundaries: ReadonlySet<number>,
): boolean {
  if (offset <= 0 || offset >= text.length || explicitBoundaries.has(offset)) {
    return false;
  }
  const previous = segmentGraphemes(text.slice(0, offset)).slice(-1).join("");
  const next = segmentGraphemes(text.slice(offset)).slice(0, 1).join("");
  if (
    naturalBoundaries.has(offset) &&
    !isCjkGrapheme(previous) &&
    !isCjkGrapheme(next)
  )
    return false;
  return isWordContent(previous) && isWordContent(next);
}

function countContentGraphemes(value: string): number {
  return segmentGraphemes(value).filter((grapheme) => !/^\s+$/u.test(grapheme))
    .length;
}

function countSemanticGraphemes(value: string): number {
  return segmentGraphemes(value).filter(isWordContent).length;
}

function isWordContent(value: string): boolean {
  return /[\p{Letter}\p{Number}\p{Mark}]/u.test(value);
}

/**
 * Wrap rich text through a finite sequence of shape-derived line slots.
 *
 * Slots use the effective inline coordinate system used for glyph measurement
 * after font-width scaling. Explicit newlines consume a slot, and all
 * word-breaking modes share the rectangular renderer's segmentation rules.
 */
export function measureStyledWrappedTextInSlots(
  context: TextMeasurementContext,
  runs: TextStyleRun[],
  slots: readonly TextLineSlot[],
  lineHeightPx: number,
  fontSize: number,
  fontFamily: string,
  letterSpacingPx: number,
  wordBreak: TextWordBreak,
  resolveRunStyle?: TextRunStyleResolver,
): SlottedWrappedTextMeasurement {
  const graphemes = measureStyledGraphemes(
    context,
    runs,
    fontSize,
    fontFamily,
    resolveRunStyle,
  );
  return measureWrappedTextInSlots(
    graphemes,
    slots,
    lineHeightPx,
    letterSpacingPx,
    wordBreak,
  );
}

/**
 * Vertical writing has a uniform top-to-bottom glyph advance. This variant
 * keeps rich styles and the same word-break policy while avoiding horizontal
 * canvas widths, which do not describe a vertical column.
 */
export function measureUniformStyledWrappedTextInSlots(
  runs: TextStyleRun[],
  slots: readonly TextLineSlot[],
  columnWidthPx: number,
  graphemeAdvancePx: number,
  wordBreak: TextWordBreak,
  resolveGraphemeAdvancePx?: (
    grapheme: string,
    style: TextRunRenderStyle,
  ) => number,
  resolveRunStyle?: TextRunStyleResolver,
  segmentText?: (text: string, run: TextStyleRun) => string[],
): SlottedWrappedTextMeasurement {
  const graphemes = measureUniformStyledGraphemes(
    runs,
    graphemeAdvancePx,
    resolveGraphemeAdvancePx,
    resolveRunStyle,
    segmentText,
  );
  return measureWrappedTextInSlots(
    graphemes,
    slots,
    columnWidthPx,
    0,
    wordBreak,
  );
}

function measureWrappedTextInSlots(
  graphemes: StyledGrapheme[],
  slots: readonly TextLineSlot[],
  lineHeightPx: number,
  letterSpacingPx: number,
  wordBreak: TextWordBreak,
): SlottedWrappedTextMeasurement {
  const paragraphs = splitParagraphs(graphemes);
  const lines: BlockTextLine[] = [];
  let fits = true;
  let consumedAll = true;

  for (const paragraph of paragraphs) {
    const measured = wrapParagraphInSlots(
      paragraph,
      slots.slice(lines.length),
      letterSpacingPx,
      resolveTextWordBreak(wordBreak),
    );
    lines.push(...measured.lines);
    fits = fits && measured.fits;
    if (!measured.consumedAll) {
      consumedAll = false;
      fits = false;
      break;
    }
  }

  return summarizeSlottedLines(lines, lineHeightPx, fits, consumedAll);
}

function splitParagraphs(graphemes: StyledGrapheme[]): StyledGrapheme[][] {
  const paragraphs: StyledGrapheme[][] = [[]];
  for (const grapheme of graphemes) {
    if (grapheme.text === "\n") {
      paragraphs.push([]);
    } else {
      paragraphs.at(-1)?.push(grapheme);
    }
  }
  return paragraphs;
}

function wrapParagraphInSlots(
  graphemes: StyledGrapheme[],
  slots: readonly TextLineSlot[],
  letterSpacingPx: number,
  wordBreak: TextWordBreak,
): {
  lines: BlockTextLine[];
  fits: boolean;
  consumedAll: boolean;
} {
  const firstSlot = slots[0];
  if (!firstSlot) {
    return { lines: [], fits: false, consumedAll: false };
  }
  if (graphemes.length === 0) {
    return {
      lines: [toSlottedLine([], 0, firstSlot)],
      fits: true,
      consumedAll: true,
    };
  }

  const units =
    wordBreak === "break-all"
      ? graphemes.map((grapheme) => [grapheme])
      : buildNaturalUnits(graphemes, !keepsWordsTogether(wordBreak));
  return new SlotParagraphWriter(
    slots,
    letterSpacingPx,
    allowsLongTokenFallback(wordBreak),
  ).wrap(units);
}

class SlotParagraphWriter {
  private readonly lines: BlockTextLine[] = [];
  private line: StyledGrapheme[] = [];
  private lineWidth = 0;
  private fits = true;

  constructor(
    private readonly slots: readonly TextLineSlot[],
    private readonly letterSpacingPx: number,
    private readonly emergencyBreak: boolean,
  ) {}

  wrap(units: StyledGrapheme[][]): {
    lines: BlockTextLine[];
    fits: boolean;
    consumedAll: boolean;
  } {
    for (const unit of units) {
      if (!this.consumeUnit(unit)) return this.result(false);
    }
    return this.pushLine() ? this.result(true) : this.result(false);
  }

  private consumeUnit(unit: StyledGrapheme[]): boolean {
    let remaining = unit;
    while (remaining.length > 0) {
      const slot = this.currentSlot();
      if (!slot) return false;
      const width = measureGraphemeSequence(remaining, this.letterSpacingPx);
      if (this.mustMoveToNextLine(width, slot)) {
        if (!this.pushLine()) return false;
        continue;
      }
      if (!this.emergencyBreak || width <= slot.availableWidth) {
        this.appendWhole(remaining, width, slot);
        return true;
      }
      remaining = this.appendEmergencyPrefix(remaining, slot);
      if (remaining.length > 0 && !this.pushLine()) return false;
    }
    return true;
  }

  private mustMoveToNextLine(width: number, slot: TextLineSlot): boolean {
    return (
      this.line.length > 0 &&
      this.lineWidth + this.letterSpacingPx + width >
        slot.availableWidth + WIDTH_EPSILON_PX
    );
  }

  private appendWhole(
    graphemes: StyledGrapheme[],
    width: number,
    slot: TextLineSlot,
  ): void {
    if (this.line.length > 0) this.lineWidth += this.letterSpacingPx;
    this.line.push(...graphemes);
    this.lineWidth += width;
    if (this.lineWidth > slot.availableWidth + WIDTH_EPSILON_PX) {
      this.fits = false;
    }
  }

  private appendEmergencyPrefix(
    graphemes: StyledGrapheme[],
    slot: TextLineSlot,
  ): StyledGrapheme[] {
    const takeCount = fittingPrefixLength(
      graphemes,
      slot.availableWidth,
      this.letterSpacingPx,
    );
    const prefix = graphemes.slice(0, takeCount);
    this.line.push(...prefix);
    this.lineWidth = measureGraphemeSequence(prefix, this.letterSpacingPx);
    return graphemes.slice(takeCount);
  }

  private pushLine(): boolean {
    const slot = this.currentSlot();
    if (!slot) return false;
    this.lines.push(toSlottedLine(this.line, this.lineWidth, slot));
    if (this.lineWidth > slot.availableWidth + WIDTH_EPSILON_PX) {
      this.fits = false;
    }
    this.line = [];
    this.lineWidth = 0;
    return true;
  }

  private currentSlot(): TextLineSlot | undefined {
    return this.slots[this.lines.length];
  }

  private result(consumedAll: boolean): {
    lines: BlockTextLine[];
    fits: boolean;
    consumedAll: boolean;
  } {
    return {
      lines: this.lines,
      fits: this.fits && consumedAll,
      consumedAll,
    };
  }
}

function fittingPrefixLength(
  graphemes: StyledGrapheme[],
  maxWidth: number,
  letterSpacingPx: number,
): number {
  let width = 0;
  for (let index = 0; index < graphemes.length; index += 1) {
    const grapheme = graphemes[index];
    if (!grapheme) break;
    const nextWidth =
      width + grapheme.width + (index > 0 ? letterSpacingPx : 0);
    if (index > 0 && nextWidth > maxWidth + WIDTH_EPSILON_PX) return index;
    width = nextWidth;
  }
  return Math.max(1, graphemes.length);
}

function toSlottedLine(
  graphemes: StyledGrapheme[],
  width: number,
  slot: TextLineSlot,
): BlockTextLine {
  return { ...toBlockTextLine(graphemes, width), slot };
}

function summarizeSlottedLines(
  lines: BlockTextLine[],
  lineHeightPx: number,
  fits: boolean,
  consumedAll: boolean,
): SlottedWrappedTextMeasurement {
  return {
    lines,
    lineCount: lines.length,
    totalHeight: lines.length * lineHeightPx,
    maxLineWidth: lines.reduce(
      (largest, line) => Math.max(largest, line.width),
      0,
    ),
    fits,
    consumedAll,
  };
}
