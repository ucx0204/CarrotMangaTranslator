import type { GatherField, GatheredBlock, GatheredPage } from "./gatherText";

export type HighlightSegment = { text: string; match: boolean };

export type VisibleLine = {
  blockId: string;
  kind: "source" | "translated";
  text: string;
};

/**
 * Splits `text` into alternating non-match / match segments for a
 * case-insensitive `query`. An empty query yields a single non-match segment.
 */
export function splitHighlightSegments(
  text: string,
  query: string,
): HighlightSegment[] {
  if (!query) {
    return [{ text, match: false }];
  }
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const segments: HighlightSegment[] = [];
  let from = 0;
  let index = lowerText.indexOf(lowerQuery, from);
  while (index !== -1) {
    if (index > from) {
      segments.push({ text: text.slice(from, index), match: false });
    }
    segments.push({
      text: text.slice(index, index + query.length),
      match: true,
    });
    from = index + query.length;
    index = lowerText.indexOf(lowerQuery, from);
  }
  if (from < text.length) {
    segments.push({ text: text.slice(from), match: false });
  }
  return segments;
}

function blockVisibleLines(
  block: GatheredBlock,
  field: GatherField,
): VisibleLine[] {
  const lines: VisibleLine[] = [];
  if (field !== "translated" && block.sourceText) {
    lines.push({ blockId: block.id, kind: "source", text: block.sourceText });
  }
  if (field !== "source" && block.translatedText) {
    lines.push({
      blockId: block.id,
      kind: "translated",
      text: block.translatedText,
    });
  }
  return lines;
}

/**
 * Lists the searchable text lines in the exact order they are rendered
 * (page → block → OCR then translation), so highlight ordinals line up.
 */
export function visibleLines(
  pages: GatheredPage[],
  field: GatherField,
): VisibleLine[] {
  const lines: VisibleLine[] = [];
  for (const page of pages) {
    for (const block of page.blocks) {
      lines.push(...blockVisibleLines(block, field));
    }
  }
  return lines;
}

function countLineMatches(text: string, query: string): number {
  return splitHighlightSegments(text, query).filter((segment) => segment.match)
    .length;
}

export function countMatches(
  pages: GatheredPage[],
  field: GatherField,
  query: string,
): number {
  if (!query) {
    return 0;
  }
  let total = 0;
  for (const line of visibleLines(pages, field)) {
    total += countLineMatches(line.text, query);
  }
  return total;
}

export function matchOffsetKey(
  blockId: string,
  kind: VisibleLine["kind"],
): string {
  return `${blockId}:${kind}`;
}

/**
 * Maps each searchable line (`blockId:kind`) to the global ordinal of its first
 * match, so each rendered line can assign deterministic match ordinals without
 * a shared render-time counter (which breaks under StrictMode double-render).
 */
export function buildMatchOffsets(
  pages: GatheredPage[],
  field: GatherField,
  query: string,
): Map<string, number> {
  const offsets = new Map<string, number>();
  if (!query) {
    return offsets;
  }
  let running = 0;
  for (const line of visibleLines(pages, field)) {
    offsets.set(matchOffsetKey(line.blockId, line.kind), running);
    running += countLineMatches(line.text, query);
  }
  return offsets;
}
