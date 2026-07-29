import {
  measureNaturalGraphemeSlice,
  type NaturalTextMetrics,
  type NaturalWrapMode,
} from "./naturalTextLayoutMetrics";
import {
  BREAK_AFTER_PUNCTUATION,
  CLOSING_PUNCTUATION,
  OPENING_PUNCTUATION,
  graphemeOffsets,
  isCjkGrapheme,
  isNaturalWhitespace,
  segmentNaturalTextWords,
  skipNaturalWhitespace,
  trimNaturalWhitespace,
} from "./naturalTextLayoutSegmentation";

const LONG_UNIT_WIDTH_RATIO = 1;

export function resolvePreferredNaturalBreaks(
  text: string,
  graphemes: string[],
  locale?: string,
): Set<number> {
  const offsets = graphemeOffsets(graphemes);
  const offsetToIndex = new Map(
    offsets.map((offset, index) => [offset, index] as const),
  );
  const words = segmentNaturalTextWords(text, locale);
  const breaks = new Set<number>([graphemes.length]);
  for (const entry of words) {
    addMappedBreak(breaks, offsetToIndex, graphemes, entry.index);
    addMappedBreak(
      breaks,
      offsetToIndex,
      graphemes,
      entry.index + entry.segment.length,
    );
  }
  const wordStarts = new Set(words.map((entry) => entry.index));
  for (let index = 1; index < graphemes.length; index += 1) {
    if (
      isPreferredAdjacentBreak(
        graphemes[index - 1],
        graphemes[index],
        wordStarts.has(offsets[index]),
      )
    ) {
      breaks.add(index);
    }
  }
  return breaks;
}

export function resolveAllowedNaturalBreaks(
  graphemes: string[],
  preferred: ReadonlySet<number>,
  maxWidth: number,
  metrics: NaturalTextMetrics,
  mode: NaturalWrapMode,
): Set<number> {
  if (mode === "grapheme") {
    return new Set(
      Array.from({ length: graphemes.length + 1 }, (_, index) => index).filter(
        (index) => isLegalNaturalBoundary(graphemes, index),
      ),
    );
  }
  const allowed = new Set(preferred);
  const anchors = Array.from(new Set([0, ...preferred, graphemes.length])).sort(
    (left, right) => left - right,
  );
  for (let index = 0; index < anchors.length - 1; index += 1) {
    addLongUnitBreaks(
      allowed,
      graphemes,
      anchors[index],
      anchors[index + 1],
      maxWidth,
      metrics,
    );
  }
  return allowed;
}

export function hasForbiddenNaturalLineEdge(
  graphemes: string[],
  start: number,
  end: number,
  following: number,
): boolean {
  return (
    CLOSING_PUNCTUATION.includes(graphemes[start]) ||
    (following < graphemes.length &&
      OPENING_PUNCTUATION.includes(graphemes[end - 1]))
  );
}

function isLegalNaturalBoundary(
  graphemes: string[],
  boundary: number,
): boolean {
  if (boundary <= 0 || boundary >= graphemes.length) {
    return boundary === graphemes.length;
  }
  return (
    !OPENING_PUNCTUATION.includes(graphemes[boundary - 1]) &&
    !CLOSING_PUNCTUATION.includes(graphemes[boundary])
  );
}

function addLongUnitBreaks(
  allowed: Set<number>,
  graphemes: string[],
  rawStart: number,
  rawEnd: number,
  maxWidth: number,
  metrics: NaturalTextMetrics,
): void {
  const start = skipNaturalWhitespace(graphemes, rawStart);
  const end = trimNaturalWhitespace(graphemes, rawEnd);
  if (
    end - start <= 1 ||
    measureNaturalGraphemeSlice(graphemes, start, end, metrics) <=
      maxWidth * LONG_UNIT_WIDTH_RATIO
  ) {
    return;
  }
  for (let boundary = start + 1; boundary < end; boundary += 1) {
    if (isLegalNaturalBoundary(graphemes, boundary)) allowed.add(boundary);
  }
}

function addMappedBreak(
  breaks: Set<number>,
  offsetToIndex: ReadonlyMap<number, number>,
  graphemes: string[],
  offset: number,
): void {
  const index = offsetToIndex.get(offset);
  if (
    index !== undefined &&
    index > 0 &&
    isLegalNaturalBoundary(graphemes, index)
  ) {
    breaks.add(index);
  }
}

function isPreferredAdjacentBreak(
  previous: string,
  next: string,
  hasWordBoundary: boolean,
): boolean {
  return (
    isNaturalWhitespace(previous) ||
    BREAK_AFTER_PUNCTUATION.includes(previous) ||
    (isCjkGrapheme(previous) && isCjkGrapheme(next) && hasWordBoundary)
  );
}
