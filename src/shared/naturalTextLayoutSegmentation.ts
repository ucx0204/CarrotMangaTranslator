export type NaturalWordSegment = {
  segment: string;
  index: number;
  isWordLike: boolean;
};

export const OPENING_PUNCTUATION = "([{<«“‘「『（［｛〈《【〔〖〘〚";
export const CLOSING_PUNCTUATION =
  ")]}>»”’,.!?:;」』）］｝〉》】〕〗〙〛、。，．！？：；…";
export const BREAK_AFTER_PUNCTUATION = "-‐‑‒–—―/";

export function segmentNaturalTextGraphemes(value: string): string[] {
  const segmenter = resolveSegmenter(undefined, "grapheme");
  return segmenter
    ? Array.from(segmenter.segment(value), (entry) => entry.segment)
    : segmentGraphemesFallback(value);
}

export function segmentNaturalTextWords(
  value: string,
  locale?: string,
): NaturalWordSegment[] {
  const segmenter = resolveSegmenter(locale, "word");
  if (segmenter) {
    return Array.from(segmenter.segment(value), (entry) => ({
      segment: entry.segment,
      index: entry.index,
      isWordLike: Boolean(entry.isWordLike),
    }));
  }
  return segmentWordsFallback(value);
}

export function normalizeParagraphWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function graphemeOffsets(graphemes: string[]): number[] {
  const offsets = [0];
  let offset = 0;
  for (const grapheme of graphemes) {
    offset += grapheme.length;
    offsets.push(offset);
  }
  return offsets;
}

export function cjkRatio(graphemes: string[]): number {
  const meaningful = graphemes.filter(
    (value) => !isNaturalWhitespace(value) && !isNaturalPunctuation(value),
  );
  if (meaningful.length === 0) return 0;
  return (
    meaningful.filter((value) => isCjkGrapheme(value)).length /
    meaningful.length
  );
}

export function isNaturalWhitespace(value: string): boolean {
  return /^\s+$/u.test(value) || value === "\u200b";
}

export function isCjkGrapheme(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u.test(
    value,
  );
}

export function isEmojiGrapheme(value: string): boolean {
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value);
}

export function isNaturalPunctuation(value: string): boolean {
  return (
    OPENING_PUNCTUATION.includes(value) ||
    CLOSING_PUNCTUATION.includes(value) ||
    BREAK_AFTER_PUNCTUATION.includes(value) ||
    /^\p{Punctuation}+$/u.test(value)
  );
}

export function skipNaturalWhitespace(
  graphemes: string[],
  start: number,
): number {
  let index = start;
  while (index < graphemes.length && isNaturalWhitespace(graphemes[index])) {
    index += 1;
  }
  return index;
}

export function trimNaturalWhitespace(
  graphemes: string[],
  end: number,
): number {
  let index = end;
  while (index > 0 && isNaturalWhitespace(graphemes[index - 1])) {
    index -= 1;
  }
  return index;
}

export function countVisibleNaturalGraphemes(
  graphemes: string[],
  start: number,
  end: number,
): number {
  return graphemes
    .slice(start, end)
    .filter((value) => !isNaturalWhitespace(value)).length;
}

/**
 * Counts graphemes carrying readable content rather than decoration.
 * Punctuation and brackets do not turn `고!`, `어,`, or `【아` into a
 * two-character line. Emoji clusters count as semantic content.
 */
export function countSemanticNaturalGraphemes(
  graphemes: string[],
  start: number,
  end: number,
): number {
  return graphemes.slice(start, end).filter(isSemanticNaturalGrapheme).length;
}

export function isSemanticNaturalGrapheme(value: string): boolean {
  return /[\p{Letter}\p{Number}]/u.test(value) || isEmojiGrapheme(value);
}

export function isNaturalPunctuationSlice(
  graphemes: string[],
  start: number,
  end: number,
): boolean {
  const visible = graphemes
    .slice(start, end)
    .filter((value) => !isNaturalWhitespace(value));
  return visible.length > 0 && visible.every(isNaturalPunctuation);
}

function resolveSegmenter(
  locale: string | undefined,
  granularity: Intl.SegmenterOptions["granularity"],
): Intl.Segmenter | null {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
    return null;
  }
  try {
    return new Intl.Segmenter(locale, { granularity });
  } catch (error) {
    void error;
    return new Intl.Segmenter(undefined, { granularity });
  }
}

function segmentWordsFallback(value: string): NaturalWordSegment[] {
  const entries: NaturalWordSegment[] = [];
  const pattern = /\s+|[^\s]+/gu;
  for (const match of value.matchAll(pattern)) {
    entries.push({
      segment: match[0],
      index: match.index,
      isWordLike: !/^\s+$/u.test(match[0]),
    });
  }
  return entries;
}

function segmentGraphemesFallback(value: string): string[] {
  const clusters: string[] = [];
  for (const point of Array.from(value)) {
    const previous = clusters.at(-1);
    if (!previous || !shouldJoinPreviousCluster(previous, point)) {
      clusters.push(point);
    } else {
      clusters[clusters.length - 1] = previous + point;
    }
  }
  return clusters;
}

function shouldJoinPreviousCluster(previous: string, point: string): boolean {
  if (isGraphemeExtend(point) || point === "\u200d") return true;
  if (previous.endsWith("\u200d")) return true;
  return isRegionalIndicator(point) && hasOddRegionalIndicatorCount(previous);
}

function isGraphemeExtend(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return (
    /\p{Mark}/u.test(value) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    (codePoint >= 0xe0020 && codePoint <= 0xe007f)
  );
}

function isRegionalIndicator(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function hasOddRegionalIndicatorCount(value: string): boolean {
  const points = Array.from(value);
  return (
    points.length > 0 &&
    points.every(isRegionalIndicator) &&
    points.length % 2 === 1
  );
}
