import type { WorkContextAnalysisCounts } from "../shared/workContextAnalysisTypes";

export function createEmptyCounts(): WorkContextAnalysisCounts {
  return {
    glossaryAdded: 0,
    glossaryUpdated: 0,
    charactersAdded: 0,
    charactersUpdated: 0,
    rulesUpdated: 0,
    pageSummariesUpserted: 0,
  };
}

export function mergeNote(
  current: string | undefined,
  next: string | undefined,
): string {
  const pieces = [cleanText(current, 2000)];
  const note = cleanText(next, 1800);
  if (note && !pieces.some((piece) => piece.includes(note))) {
    pieces.push(note);
  }
  return cleanText(pieces.filter(Boolean).join(" / "), 2000);
}

export function sanitizeList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  return [
    ...new Map(
      toArray(value)
        .map((item) => cleanText(item, maxLength))
        .filter(Boolean)
        .map((item) => [normalizeKey(item), item]),
    ).values(),
  ].slice(0, maxItems);
}

export function cleanText(value: unknown, maxLength: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

export function normalizeKey(value: unknown): string {
  return cleanText(value, 400).toLocaleLowerCase();
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
