/**
 * Minimal markdown-ish inline parser for translation text.
 *
 * Supported markers (never produce HTML — only safe style runs):
 *   - `**bold**`
 *   - `*italic*`
 *   - `***bold italic***`
 *   - `\*` escapes a literal asterisk
 *
 * Rules:
 *   - Newlines are preserved.
 *   - Unmatched / unclosed markers render as literal characters.
 *   - Matching is non-greedy: a marker pairs with the nearest closing marker
 *     of the same length.
 *   - Block-wide bold/italic compose with inline markers: the effective style
 *     of a run is `blockBold || runBold`, `blockItalic || runItalic`. Inline
 *     markers can only add emphasis, never remove the block-wide one.
 */

export type TextStyleRun = {
  text: string;
  bold: boolean;
  italic: boolean;
};

export type ParsedRichText = {
  runs: TextStyleRun[];
  plainText: string;
};

const MARKERS = ["***", "**", "*"] as const;
const MAX_PARSE_DEPTH = 8;

export function parseRichText(
  input: string,
  baseBold = false,
  baseItalic = false,
): ParsedRichText {
  const raw = typeof input === "string" ? input : String(input ?? "");
  const runs: TextStyleRun[] = [];
  parseSegment(raw, baseBold, baseItalic, 0, runs);
  const merged = mergeRuns(runs);
  return {
    runs: merged,
    plainText: merged.map((run) => run.text).join(""),
  };
}

/** Convenience for callers that only need the marker-free string. */
export function stripRichTextMarkup(input: string): string {
  return parseRichText(input).plainText;
}

function parseSegment(
  input: string,
  bold: boolean,
  italic: boolean,
  depth: number,
  runs: TextStyleRun[],
): void {
  let buffer = "";
  let index = 0;

  const flush = (): void => {
    if (buffer) {
      runs.push({ text: buffer, bold, italic });
      buffer = "";
    }
  };

  while (index < input.length) {
    const char = input[index];

    if (char === "\\" && input[index + 1] === "*") {
      buffer += "*";
      index += 2;
      continue;
    }

    if (char === "*" && depth < MAX_PARSE_DEPTH) {
      const match = matchMarker(input, index);
      if (match) {
        flush();
        parseSegment(
          match.inner,
          bold || match.bold,
          italic || match.italic,
          depth + 1,
          runs,
        );
        index = match.nextIndex;
        continue;
      }
    }

    if (char === "*") {
      // Unmatched marker: emit a single literal asterisk and move on.
      buffer += "*";
      index += 1;
      continue;
    }

    buffer += char;
    index += 1;
  }

  flush();
}

type MarkerMatch = {
  inner: string;
  bold: boolean;
  italic: boolean;
  nextIndex: number;
};

function matchMarker(input: string, start: number): MarkerMatch | null {
  for (const marker of MARKERS) {
    if (!input.startsWith(marker, start)) {
      continue;
    }
    const innerStart = start + marker.length;
    const closeIndex = findClosingMarker(input, innerStart, marker);
    if (closeIndex < 0) {
      continue;
    }
    const inner = input.slice(innerStart, closeIndex);
    if (!inner) {
      continue;
    }
    return {
      inner,
      bold: marker.length >= 2,
      italic: marker.length === 1 || marker.length === 3,
      nextIndex: closeIndex + marker.length,
    };
  }
  return null;
}

function findClosingMarker(
  input: string,
  from: number,
  marker: string,
): number {
  let index = from;
  while (index < input.length) {
    if (input[index] === "\\") {
      index += 2;
      continue;
    }
    if (input.startsWith(marker, index)) {
      return index;
    }
    index += 1;
  }
  return -1;
}

function mergeRuns(runs: TextStyleRun[]): TextStyleRun[] {
  const merged: TextStyleRun[] = [];
  for (const run of runs) {
    if (!run.text) {
      continue;
    }
    const last = merged.at(-1);
    if (last && last.bold === run.bold && last.italic === run.italic) {
      last.text += run.text;
      continue;
    }
    merged.push({ ...run });
  }
  if (merged.length === 0) {
    return [{ text: "", bold: false, italic: false }];
  }
  return merged;
}
