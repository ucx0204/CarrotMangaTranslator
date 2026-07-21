let graphemeSegmenter: Intl.Segmenter | null | undefined;
let wordSegmenter: Intl.Segmenter | null | undefined;

export function segmentGraphemes(value: string): string[] {
  const segmenter = resolveGraphemeSegmenter();
  return segmenter
    ? Array.from(segmenter.segment(value), (entry) => entry.segment)
    : segmentGraphemesFallback(value);
}

export function resolveNaturalWordBreakOffsets(
  graphemes: Array<{ text: string }>,
): ReadonlySet<number> {
  const segmenter = resolveWordSegmenter();
  if (!segmenter) return new Set();
  const text = graphemes.map((grapheme) => grapheme.text).join("");
  return new Set(
    Array.from(segmenter.segment(text), (entry) => entry.index).filter(
      (index) => index > 0,
    ),
  );
}

export function shouldBreakNaturally(
  previous: string,
  next: string,
  allowCjkBreaks: boolean,
  hasWordBoundary: boolean,
): boolean {
  // Preserve spaces at the end of the preceding unit, matching the fixed-line
  // renderer's `white-space: pre` behavior.
  if (isForbiddenBoundary(previous, next)) return false;
  if (isBreakAfter(previous)) return true;

  const touchesCjk = isCjk(previous) || isCjk(next);
  if (hasWordBoundary && (allowCjkBreaks || !touchesCjk)) return true;
  return allowCjkBreaks && touchesCjk;
}

function isForbiddenBoundary(previous: string, next: string): boolean {
  return (
    isWhitespace(next) ||
    isOpeningPunctuation(previous) ||
    isClosingPunctuation(next)
  );
}

function isBreakAfter(value: string): boolean {
  return (
    isWhitespace(value) ||
    isBreakAfterPunctuation(value) ||
    isClosingPunctuation(value)
  );
}

function resolveGraphemeSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter !== undefined) return graphemeSegmenter;
  graphemeSegmenter = resolveSegmenter("grapheme");
  return graphemeSegmenter;
}

function resolveWordSegmenter(): Intl.Segmenter | null {
  if (wordSegmenter !== undefined) return wordSegmenter;
  wordSegmenter = resolveSegmenter("word");
  return wordSegmenter;
}

function resolveSegmenter(
  granularity: Intl.SegmenterOptions["granularity"],
): Intl.Segmenter | null {
  return typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity })
    : null;
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

function isWhitespace(value: string): boolean {
  return /^\s+$/u.test(value) || value === "\u200b";
}

function isCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u.test(
    value,
  );
}

function isOpeningPunctuation(value: string): boolean {
  return "([{<«“‘「『（［｛〈《【〔〖〘〚".includes(value);
}

function isClosingPunctuation(value: string): boolean {
  return ")]}>»”’,.!?:;」』）］｝〉》】〕〗〙〛、。，．！？：；…".includes(
    value,
  );
}

function isBreakAfterPunctuation(value: string): boolean {
  return "-‐‑‒–—―/".includes(value);
}
