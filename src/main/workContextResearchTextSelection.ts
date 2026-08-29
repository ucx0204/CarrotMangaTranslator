export function selectPriorityTextItemIndexes(
  texts: readonly string[],
  priorityTerms: readonly string[],
): number[] {
  const terms = Array.from(
    new Set(
      priorityTerms
        .map(normalizeResearchMatchText)
        .filter((term) => term.length >= 2),
    ),
  );
  const normalizedTexts = texts.map(normalizeResearchMatchText);
  const selected: number[] = [];
  for (let pass = 0; pass < 2; pass += 1) {
    for (const term of terms) {
      const match = findMatchingTextIndex(normalizedTexts, term, pass);
      if (match !== null) selected.push(match);
    }
  }
  return selected;
}

export function spreadItemIndexes(itemCount: number): number[] {
  if (itemCount <= 0) return [];
  if (itemCount <= 2) {
    return Array.from({ length: itemCount }, (_unused, index) => index);
  }
  const indexes: number[] = [0, itemCount - 1];
  const intervals: Array<[number, number]> = [[0, itemCount - 1]];
  while (intervals.length > 0) {
    const [start, end] = intervals.shift() ?? [0, 0];
    if (end - start <= 1) continue;
    const middle = Math.floor((start + end) / 2);
    indexes.push(middle);
    intervals.push([start, middle], [middle, end]);
  }
  return Array.from(new Set(indexes));
}

function findMatchingTextIndex(
  texts: readonly string[],
  term: string,
  occurrence: number,
): number | null {
  let matches = 0;
  for (const [index, text] of texts.entries()) {
    if (!text.includes(term)) continue;
    if (matches === occurrence) return index;
    matches += 1;
  }
  return null;
}

function normalizeResearchMatchText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleLowerCase();
}
