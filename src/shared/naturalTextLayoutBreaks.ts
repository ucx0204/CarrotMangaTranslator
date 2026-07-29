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
  isHangulWord,
  isKoreanNaturalText,
  isNaturalPunctuation,
  isNaturalWhitespace,
  segmentNaturalTextEojeols,
  segmentNaturalTextGraphemes,
  segmentNaturalTextWords,
  skipNaturalWhitespace,
  trimNaturalWhitespace,
  type NaturalWordSegment,
} from "./naturalTextLayoutSegmentation";

const LONG_UNIT_WIDTH_RATIO = 1;
const KOREAN_COPULA_TAIL =
  /(?:이었|였)(?:어요|어|습니다|습니까|다|나|니|냐|지|죠|고|는데|지만)?$/u;
const KOREAN_LEFT_DEPENDENT_WORDS = new Set([
  "이",
  "그",
  "저",
  "이런",
  "그런",
  "저런",
  "어느",
  "어떤",
  "무슨",
  "웬",
]);
const KOREAN_RIGHT_DEPENDENT_EOJEOL =
  /^(?:것|거|수|줄|바|데|뿐|듯|만큼|때문)(?:은|는|이|가|을|를|의|에|에서|도|만|로|으로|와|과|부터|까지)?$/u;

export type NaturalBreakProfile = {
  preferred: Set<number>;
  secondary: Set<number>;
  discouraged: Set<number>;
  koreanBreakPriority: boolean;
};

/**
 * Separates ordinary eojeol boundaries from two narrower Korean cases:
 * conservative copula endings that remain readable when split, and phrase
 * boundaries that should stay together when the bubble has room.
 */
export function resolveNaturalBreakProfile(
  text: string,
  graphemes: string[],
  locale?: string,
): NaturalBreakProfile {
  const preferred = resolvePreferredNaturalBreaks(text, graphemes, locale);
  const secondary = new Set<number>();
  const discouraged = new Set<number>();
  const offsets = graphemeOffsets(graphemes);
  const offsetToIndex = new Map(
    offsets.map((offset, index) => [offset, index] as const),
  );
  const words = resolveNaturalWordUnits(text, locale).filter(
    (entry) => entry.isWordLike,
  );
  const koreanBreakPriority = isKoreanNaturalText(text);

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    addKoreanCopulaBreak(
      secondary,
      offsetToIndex,
      graphemes,
      word.segment,
      word.index,
    );
    const next = words[index + 1];
    if (
      next &&
      (KOREAN_LEFT_DEPENDENT_WORDS.has(word.segment) ||
        KOREAN_RIGHT_DEPENDENT_EOJEOL.test(next.segment))
    ) {
      addMappedBreak(
        discouraged,
        offsetToIndex,
        graphemes,
        word.index + word.segment.length,
      );
    }
  }
  return { preferred, secondary, discouraged, koreanBreakPriority };
}

function resolvePreferredNaturalBreaks(
  text: string,
  graphemes: string[],
  locale?: string,
): Set<number> {
  const offsets = graphemeOffsets(graphemes);
  const offsetToIndex = new Map(
    offsets.map((offset, index) => [offset, index] as const),
  );
  const words = resolveNaturalWordUnits(text, locale);
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
  secondary: ReadonlySet<number>,
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
  const allowed = new Set([...preferred, ...secondary]);
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

function addKoreanCopulaBreak(
  breaks: Set<number>,
  offsetToIndex: ReadonlyMap<number, number>,
  graphemes: string[],
  word: string,
  wordOffset: number,
): void {
  const core = trimTrailingNaturalPunctuation(word);
  if (!isHangulWord(core)) return;
  const match = KOREAN_COPULA_TAIL.exec(core);
  if (match?.index === undefined || match.index <= 0) return;
  const prefix = word.slice(0, match.index);
  const tail = match[0];
  if (
    segmentNaturalTextGraphemes(prefix).length !== 2 ||
    segmentNaturalTextGraphemes(tail).length < 2
  ) {
    return;
  }
  addMappedBreak(breaks, offsetToIndex, graphemes, wordOffset + match.index);
}

function trimTrailingNaturalPunctuation(value: string): string {
  const graphemes = segmentNaturalTextGraphemes(value);
  while (graphemes.length > 0 && isNaturalPunctuation(graphemes.at(-1) ?? "")) {
    graphemes.pop();
  }
  return graphemes.join("");
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
  const previous = graphemes[boundary - 1];
  const next = graphemes[boundary];
  return (
    !OPENING_PUNCTUATION.includes(previous) &&
    !CLOSING_PUNCTUATION.includes(next) &&
    !BREAK_AFTER_PUNCTUATION.includes(next) &&
    !isNonBreakingNaturalPair(previous, next)
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

function resolveNaturalWordUnits(
  text: string,
  locale?: string,
): NaturalWordSegment[] {
  return isKoreanNaturalText(text)
    ? segmentNaturalTextEojeols(text)
    : segmentNaturalTextWords(text, locale);
}

function isNonBreakingNaturalPair(previous: string, next: string): boolean {
  if (
    previous === "\u2060" ||
    next === "\u2060" ||
    previous === "\u00a0" ||
    next === "\u00a0"
  ) {
    return true;
  }
  const number = /^\p{Number}$/u;
  const numericPrefix = /^(?:\p{Sc}|[+\-−])$/u;
  const numericSuffix = /^(?:\p{Sc}|[%‰‱℃℉])$/u;
  return (
    (numericPrefix.test(previous) && number.test(next)) ||
    (number.test(previous) && numericSuffix.test(next))
  );
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
