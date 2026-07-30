import type {
  AutomaticFontCandidate,
  AutomaticFontUnicodeRange,
} from "../shared/fontMatchingTypes";

export function fontCandidateSupportsText(
  candidate: Pick<AutomaticFontCandidate, "unicodeRanges">,
  text: string,
): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      !isIgnorableCodePoint(codePoint) &&
      !rangesContainCodePoint(candidate.unicodeRanges, codePoint)
    ) {
      return false;
    }
  }
  return true;
}

export function fontCandidateCoversRange(
  candidate: Pick<AutomaticFontCandidate, "unicodeRanges">,
  startCodePoint: number,
  endCodePoint: number,
): boolean {
  if (!isValidCodePointRange(startCodePoint, endCodePoint)) {
    return false;
  }
  let cursor = startCodePoint;
  for (const [start, end] of candidate.unicodeRanges) {
    if (end < cursor) continue;
    if (start > cursor) return false;
    cursor = Math.max(cursor, end + 1);
    if (cursor > endCodePoint) return true;
  }
  return false;
}

export function countFontCandidateCodePointsInRange(
  candidate: Pick<AutomaticFontCandidate, "unicodeRanges">,
  startCodePoint: number,
  endCodePoint: number,
): number {
  if (!isValidCodePointRange(startCodePoint, endCodePoint)) {
    return 0;
  }
  return candidate.unicodeRanges.reduce((count, [start, end]) => {
    const overlapStart = Math.max(start, startCodePoint);
    const overlapEnd = Math.min(end, endCodePoint);
    return (
      count + (overlapStart <= overlapEnd ? overlapEnd - overlapStart + 1 : 0)
    );
  }, 0);
}

export function rangesContainCodePoint(
  ranges: readonly AutomaticFontUnicodeRange[],
  codePoint: number,
): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (codePoint < range[0]) {
      high = middle - 1;
    } else if (codePoint > range[1]) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function isValidCodePointRange(
  startCodePoint: number,
  endCodePoint: number,
): boolean {
  return (
    Number.isInteger(startCodePoint) &&
    Number.isInteger(endCodePoint) &&
    startCodePoint >= 0 &&
    startCodePoint <= endCodePoint &&
    endCodePoint <= 0x10ffff
  );
}

function isIgnorableCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x20 ||
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0xfe0e ||
    codePoint === 0xfe0f
  );
}
