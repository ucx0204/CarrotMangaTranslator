import {
  BREAK_AFTER_PUNCTUATION,
  CLOSING_PUNCTUATION,
  OPENING_PUNCTUATION,
  isCjkGrapheme,
  isNaturalWhitespace,
  segmentNaturalTextGraphemes,
  trySegmentNaturalTextWords,
} from "../../../shared/naturalTextLayoutSegmentation";

export function segmentGraphemes(value: string): string[] {
  return segmentNaturalTextGraphemes(value);
}

export function resolveNaturalWordBreakOffsets(
  graphemes: Array<{ text: string }>,
): ReadonlySet<number> {
  const segments = trySegmentNaturalTextWords(
    graphemes.map((grapheme) => grapheme.text).join(""),
  );
  if (!segments) return new Set();
  return new Set(
    segments.map((entry) => entry.index).filter((index) => index > 0),
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

function isWhitespace(value: string): boolean {
  return isNaturalWhitespace(value);
}

function isCjk(value: string): boolean {
  return isCjkGrapheme(value);
}

function isOpeningPunctuation(value: string): boolean {
  return OPENING_PUNCTUATION.includes(value);
}

function isClosingPunctuation(value: string): boolean {
  return CLOSING_PUNCTUATION.includes(value);
}

function isBreakAfterPunctuation(value: string): boolean {
  return BREAK_AFTER_PUNCTUATION.includes(value);
}
