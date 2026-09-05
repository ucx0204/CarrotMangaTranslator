import {
  CLOSING_PUNCTUATION,
  OPENING_PUNCTUATION,
} from "../../../shared/naturalTextLayoutSegmentation";
import {
  allowsLongTokenFallback,
  keepsWordsTogether,
  type TextWordBreak,
} from "../../../shared/textWrapping";
import {
  buildNaturalUnits,
  toBlockTextLine,
  type StyledGrapheme,
  type TextLineSlot,
} from "./overlayTextWrapping";
import type { SlottedWrappedTextMeasurement } from "./bubbleTextWrapping";

type ParagraphPath = {
  cost: number;
  splits: number;
  fragments: number;
  ends: number[];
};
type ParagraphRank = {
  layoutCost: number;
  wordSplitCount: number;
  fragmentLineCount: number;
  lineCount: number;
};
type BalancedParagraph = SlottedWrappedTextMeasurement & ParagraphRank;
const CONTENT_GLYPH = /[\p{Letter}\p{Number}]/u;
const WORD_GLYPH = /[\p{Letter}\p{Number}\p{Mark}]/u;
const SPACE_GLYPH = /^\s+$/u;

export function compareBalancedParagraphs(
  left: ParagraphRank,
  right: ParagraphRank,
): number {
  return (
    left.wordSplitCount - right.wordSplitCount ||
    left.fragmentLineCount - right.fragmentLineCount ||
    left.lineCount - right.lineCount ||
    left.layoutCost - right.layoutCost
  );
}

/** Compare a whole paragraph using the loaded font's measured graphemes. */
export function measureBalancedBubbleParagraph(
  graphemes: StyledGrapheme[],
  slots: readonly TextLineSlot[],
  lineHeightPx: number,
  letterSpacingPx: number,
  wordBreak: TextWordBreak,
): BalancedParagraph | null {
  if (
    !graphemes.length ||
    graphemes.length > 256 ||
    !slots.length ||
    slots.length > graphemes.length ||
    graphemes.some((g) => g.text === "\n")
  )
    return null;
  return new BalancedParagraphSolver(
    graphemes,
    slots,
    lineHeightPx,
    letterSpacingPx,
    wordBreak,
  ).measure();
}

class BalancedParagraphSolver {
  private readonly boundaries: Set<number>;
  private readonly wordBoundaries: Set<number>;
  private readonly allowsEmergencyBreak: boolean;
  private readonly contentLength: number;
  private readonly prefix = [0];
  private readonly idealWidth: number;
  private readonly memo = new Map<string, ParagraphPath | null>();

  constructor(
    private readonly graphemes: StyledGrapheme[],
    private readonly slots: readonly TextLineSlot[],
    private readonly lineHeightPx: number,
    private readonly letterSpacingPx: number,
    private readonly wordBreak: TextWordBreak,
  ) {
    this.boundaries = unitBoundaries(graphemes, !keepsWordsTogether(wordBreak));
    this.wordBoundaries = unitBoundaries(graphemes, false);
    this.allowsEmergencyBreak = allowsLongTokenFallback(wordBreak);
    this.contentLength = graphemes.filter((g) =>
      CONTENT_GLYPH.test(g.text),
    ).length;
    for (const glyph of graphemes)
      this.prefix.push(
        (this.prefix.at(-1) ?? 0) + glyph.width + letterSpacingPx,
      );
    this.idealWidth = this.width(0, graphemes.length) / slots.length;
  }

  measure(): BalancedParagraph | null {
    const selected = this.solve(0, 0);
    if (!selected) return null;
    let start = 0;
    const lines = selected.ends.map((end, index) => {
      const line = {
        ...toBlockTextLine(
          this.graphemes.slice(start, end),
          this.width(start, end),
          true,
        ),
        slot: this.slots[index],
      };
      start = end;
      return line;
    });
    return {
      lines,
      fits: true,
      consumedAll: true,
      lineCount: lines.length,
      totalHeight: lines.length * this.lineHeightPx,
      maxLineWidth: Math.max(...lines.map((line) => line.width)),
      wordSplitCount: selected.splits,
      fragmentLineCount: selected.fragments,
      layoutCost: selected.cost,
    };
  }

  private width(start: number, end: number): number {
    while (end > start && SPACE_GLYPH.test(this.graphemes[end - 1].text)) end--;
    return end === start
      ? 0
      : this.prefix[end] - this.prefix[start] - this.letterSpacingPx;
  }

  private allowsBreak(end: number): boolean {
    if (end === this.graphemes.length) return true;
    if (
      this.wordBreak !== "break-all" &&
      !this.boundaries.has(end) &&
      !this.allowsEmergencyBreak
    )
      return false;
    const previous = this.graphemes[end - 1].text;
    const next = this.graphemes[end].text;
    const punctuationTail =
      this.allowsEmergencyBreak &&
      WORD_GLYPH.test(previous) &&
      this.graphemes
        .slice(end)
        .every((g) => CLOSING_PUNCTUATION.includes(g.text));
    return (
      !(CLOSING_PUNCTUATION.includes(next) && !punctuationTail) &&
      !OPENING_PUNCTUATION.includes(previous) &&
      !SPACE_GLYPH.test(next)
    );
  }

  private splitsWord(end: number): boolean {
    return (
      end < this.graphemes.length &&
      !this.wordBoundaries.has(end) &&
      WORD_GLYPH.test(this.graphemes[end - 1].text) &&
      WORD_GLYPH.test(this.graphemes[end].text)
    );
  }

  private isFragment(start: number, end: number): boolean {
    if (this.slots.length <= 1 || this.contentLength === 0) return false;
    const contentInLine = this.graphemes
      .slice(start, end)
      .filter((g) => CONTENT_GLYPH.test(g.text)).length;
    return (
      contentInLine === 0 || (this.contentLength > 4 && contentInLine <= 1)
    );
  }

  private extend(
    tail: ParagraphPath,
    start: number,
    end: number,
    measuredWidth: number,
  ): ParagraphPath {
    return {
      splits: tail.splits + Number(this.splitsWord(end)),
      fragments: tail.fragments + Number(this.isFragment(start, end)),
      cost:
        tail.cost +
        ((measuredWidth - this.idealWidth) / Math.max(1, this.lineHeightPx)) **
          2,
      ends: [end, ...tail.ends],
    };
  }

  private solve(row: number, start: number): ParagraphPath | null {
    if (row === this.slots.length)
      return start === this.graphemes.length
        ? { cost: 0, splits: 0, fragments: 0, ends: [] }
        : null;
    if (this.graphemes.length - start < this.slots.length - row) return null;
    const key = `${row}:${start}`;
    const cached = this.memo.get(key);
    if (cached !== undefined) return cached;
    let best: ParagraphPath | null = null;
    for (let end = start + 1; end <= this.graphemes.length; end++) {
      const measuredWidth = this.width(start, end);
      if (measuredWidth > this.slots[row].availableWidth + 1e-6) break;
      if (!this.allowsBreak(end)) continue;
      const tail = this.solve(row + 1, end);
      if (
        !tail ||
        !this.graphemes.slice(start, end).some((g) => !SPACE_GLYPH.test(g.text))
      )
        continue;
      const candidate = this.extend(tail, start, end, measuredWidth);
      if (!best || comparePaths(candidate, best) < 0) best = candidate;
    }
    this.memo.set(key, best);
    return best;
  }
}

function comparePaths(left: ParagraphPath, right: ParagraphPath): number {
  return (
    left.splits - right.splits ||
    left.fragments - right.fragments ||
    left.cost - right.cost
  );
}

function unitBoundaries(
  graphemes: StyledGrapheme[],
  allowCjkBreaks: boolean,
): Set<number> {
  let end = 0;
  return new Set(
    buildNaturalUnits(graphemes, allowCjkBreaks).map(
      (unit) => (end += unit.length),
    ),
  );
}
