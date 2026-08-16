/* eslint-disable max-lines -- parsing, normalization, range editing, and serialization share one safe markup grammar contract */
import {
  clampFontSizePx,
  MAX_FONT_SIZE_PX,
  MIN_FONT_SIZE_PX,
} from "./blockFormatValues";

/**
 * Safe inline formatting used by translation text.
 *
 * The stored representation is deliberately text-only. It never accepts or
 * emits HTML, so project files can be rendered in both the editor and exports
 * without trusting arbitrary markup.
 */
export type TextStyleRun = {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Absolute page font size. Auto-fit applies one common temporary scale. */
  sizePx?: number;
  /** Block font id, not a raw CSS family. */
  fontFamily?: string;
  /** Absolute text opacity from 0 to 1. */
  opacity?: number;
};

export type ParsedRichText = {
  runs: TextStyleRun[];
  plainText: string;
};

export type TextStylePatch = {
  bold?: boolean | null;
  italic?: boolean | null;
  sizePx?: number | null;
  fontFamily?: string | null;
  opacity?: number | null;
};

const MARKERS = ["***", "**", "*"] as const;
const MAX_PARSE_DEPTH = 16;
const FONT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

type StyleContext = Omit<TextStyleRun, "text">;
type StyleTagName = "size" | "font" | "opacity";

type StyleTagMatch = {
  name: StyleTagName;
  nextIndex: number;
  patch: TextStylePatch;
};

export function parseRichText(
  input: string,
  baseBold = false,
  baseItalic = false,
): ParsedRichText {
  const raw = typeof input === "string" ? input : String(input ?? "");
  const runs: TextStyleRun[] = [];
  parseSegment(raw, { bold: baseBold, italic: baseItalic }, 0, runs);
  const merged = mergeTextStyleRuns(runs);
  return {
    runs: merged,
    plainText: merged.map((run) => run.text).join(""),
  };
}

/** Convenience for callers that only need the formatting-free string. */
export function stripRichTextMarkup(input: string): string {
  return parseRichText(input).plainText;
}

/** Serialize style runs back to the safe, deterministic project markup. */
export function serializeRichTextRuns(runs: readonly TextStyleRun[]): string {
  return mergeTextStyleRuns(runs)
    .map((run) => serializeRun(run))
    .join("");
}

/**
 * Apply a style to a plain-text selection. Offsets are UTF-16 offsets, matching
 * textarea/contenteditable selection APIs. Text outside the range is untouched.
 */
export function applyTextStyleToRuns(
  runs: readonly TextStyleRun[],
  selectionStart: number,
  selectionEnd: number,
  patch: TextStylePatch,
): TextStyleRun[] {
  const textLength = runs.reduce((total, run) => total + run.text.length, 0);
  const start = clampIndex(selectionStart, textLength);
  const end = clampIndex(selectionEnd, textLength);
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  if (from === to) return mergeTextStyleRuns(runs);

  const result: TextStyleRun[] = [];
  let runStart = 0;
  for (const run of runs) {
    const runEnd = runStart + run.text.length;
    const overlapStart = Math.max(from, runStart);
    const overlapEnd = Math.min(to, runEnd);
    if (overlapStart >= overlapEnd) {
      result.push({ ...run });
      runStart = runEnd;
      continue;
    }

    const localStart = overlapStart - runStart;
    const localEnd = overlapEnd - runStart;
    if (localStart > 0) {
      result.push({ ...run, text: run.text.slice(0, localStart) });
    }
    result.push(
      applyStylePatch(
        { ...run, text: run.text.slice(localStart, localEnd) },
        patch,
      ),
    );
    if (localEnd < run.text.length) {
      result.push({ ...run, text: run.text.slice(localEnd) });
    }
    runStart = runEnd;
  }
  return mergeTextStyleRuns(result);
}

export function clearTextStylesFromRuns(
  runs: readonly TextStyleRun[],
  selectionStart = 0,
  selectionEnd = runs.reduce((total, run) => total + run.text.length, 0),
): TextStyleRun[] {
  return applyTextStyleToRuns(runs, selectionStart, selectionEnd, {
    bold: null,
    italic: null,
    sizePx: null,
    fontFamily: null,
    opacity: null,
  });
}

export function mergeTextStyleRuns(
  runs: readonly TextStyleRun[],
): TextStyleRun[] {
  const merged: TextStyleRun[] = [];
  for (const candidate of runs) {
    if (!candidate.text) continue;
    const run = normalizeRun(candidate);
    const last = merged.at(-1);
    if (last && haveSameStyle(last, run)) {
      last.text += run.text;
    } else {
      merged.push(run);
    }
  }
  if (merged.length === 0) {
    return [{ text: "", bold: false, italic: false }];
  }
  return merged;
}

function parseSegment(
  input: string,
  style: StyleContext,
  depth: number,
  runs: TextStyleRun[],
): void {
  let buffer = "";
  let index = 0;

  const flush = (): void => {
    if (!buffer) return;
    runs.push({ text: buffer, ...style });
    buffer = "";
  };

  while (index < input.length) {
    const char = input[index];
    const escaped = readEscapedCharacter(input, index);
    if (escaped) {
      buffer += escaped.value;
      index = escaped.nextIndex;
      continue;
    }

    const styleSegment =
      char === "[" && depth < MAX_PARSE_DEPTH
        ? matchStyleSegment(input, index)
        : null;
    if (styleSegment) {
      flush();
      parseSegment(
        input.slice(styleSegment.opening.nextIndex, styleSegment.closeIndex),
        applyContextPatch(style, styleSegment.opening.patch),
        depth + 1,
        runs,
      );
      index =
        styleSegment.closeIndex +
        closingStyleTag(styleSegment.opening.name).length;
      continue;
    }

    if (char === "*" && depth < MAX_PARSE_DEPTH) {
      const match = matchMarker(input, index);
      if (match) {
        flush();
        parseSegment(
          match.inner,
          {
            ...style,
            bold: style.bold || match.bold,
            italic: style.italic || match.italic,
          },
          depth + 1,
          runs,
        );
        index = match.nextIndex;
        continue;
      }
    }

    buffer += char;
    index += 1;
  }
  flush();
}

function matchStyleSegment(
  input: string,
  start: number,
): { opening: StyleTagMatch; closeIndex: number } | null {
  const opening = matchStyleOpeningTag(input, start);
  if (!opening) return null;
  const closeIndex = findClosingStyleTag(
    input,
    opening.nextIndex,
    opening.name,
  );
  return closeIndex < 0 ? null : { opening, closeIndex };
}

// eslint-disable-next-line complexity -- each allowlisted tag validates its own bounded value before entering the run model
function matchStyleOpeningTag(
  input: string,
  start: number,
): StyleTagMatch | null {
  const end = input.indexOf("]", start + 1);
  if (end < 0 || end - start > 140) return null;
  const body = input.slice(start + 1, end);
  const equals = body.indexOf("=");
  if (equals <= 0) return null;
  const name = body.slice(0, equals) as StyleTagName;
  const rawValue = body.slice(equals + 1).trim();
  const nextIndex = end + 1;

  if (name === "size") {
    const value = Number(rawValue);
    if (
      !Number.isFinite(value) ||
      value < MIN_FONT_SIZE_PX ||
      value > MAX_FONT_SIZE_PX
    ) {
      return null;
    }
    return {
      name,
      nextIndex,
      patch: { sizePx: clampFontSizePx(value) },
    };
  }
  if (name === "font") {
    if (!FONT_ID_PATTERN.test(rawValue)) return null;
    return { name, nextIndex, patch: { fontFamily: rawValue } };
  }
  if (name === "opacity") {
    const percent = Number(rawValue);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
    return {
      name,
      nextIndex,
      patch: { opacity: normalizeOpacity(percent / 100) },
    };
  }
  return null;
}

function findClosingStyleTag(
  input: string,
  from: number,
  name: StyleTagName,
): number {
  const closing = closingStyleTag(name);
  let nesting = 0;
  let index = from;
  while (index < input.length) {
    const escaped = readEscapedCharacter(input, index);
    if (escaped) {
      index = escaped.nextIndex;
      continue;
    }
    if (input.startsWith(closing, index)) {
      if (nesting === 0) return index;
      nesting -= 1;
      index += closing.length;
      continue;
    }
    if (input[index] === "[") {
      const opening = matchStyleOpeningTag(input, index);
      if (opening?.name === name) {
        nesting += 1;
        index = opening.nextIndex;
        continue;
      }
    }
    index += 1;
  }
  return -1;
}

function closingStyleTag(name: StyleTagName): string {
  return `[/${name}]`;
}

type MarkerMatch = {
  inner: string;
  bold: boolean;
  italic: boolean;
  nextIndex: number;
};

function matchMarker(input: string, start: number): MarkerMatch | null {
  for (const marker of MARKERS) {
    if (!input.startsWith(marker, start)) continue;
    const innerStart = start + marker.length;
    const closeIndex = findClosingMarker(input, innerStart, marker);
    if (closeIndex < 0) continue;
    const inner = input.slice(innerStart, closeIndex);
    if (!inner) continue;
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
    const escaped = readEscapedCharacter(input, index);
    if (escaped) {
      index = escaped.nextIndex;
      continue;
    }
    if (input.startsWith(marker, index)) return index;
    index += 1;
  }
  return -1;
}

function readEscapedCharacter(
  input: string,
  index: number,
): { value: string; nextIndex: number } | null {
  if (input[index] !== "\\") return null;
  const next = input[index + 1];
  if (next !== "\\" && next !== "*" && next !== "[") return null;
  return { value: next, nextIndex: index + 2 };
}

function serializeRun(run: TextStyleRun): string {
  let content = escapeRichText(run.text);
  if (run.bold && run.italic) content = `***${content}***`;
  else if (run.bold) content = `**${content}**`;
  else if (run.italic) content = `*${content}*`;
  if (run.opacity !== undefined) {
    content = `[opacity=${formatNumber(normalizeOpacity(run.opacity) * 100)}]${content}[/opacity]`;
  }
  if (run.sizePx !== undefined) {
    content = `[size=${formatNumber(clampFontSizePx(run.sizePx))}]${content}[/size]`;
  }
  if (run.fontFamily && FONT_ID_PATTERN.test(run.fontFamily)) {
    content = `[font=${run.fontFamily}]${content}[/font]`;
  }
  return content;
}

function escapeRichText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[");
}

function applyStylePatch(
  run: TextStyleRun,
  patch: TextStylePatch,
): TextStyleRun {
  const next = { ...run };
  applyOptionalPatch(next, "bold", patch.bold);
  applyOptionalPatch(next, "italic", patch.italic);
  applyOptionalPatch(next, "sizePx", patch.sizePx);
  applyOptionalPatch(next, "fontFamily", patch.fontFamily);
  applyOptionalPatch(next, "opacity", patch.opacity);
  return normalizeRun(next);
}

function applyContextPatch(
  style: StyleContext,
  patch: TextStylePatch,
): StyleContext {
  const { text: _text, ...next } = applyStylePatch(
    { text: "", ...style },
    patch,
  );
  return next;
}

function applyOptionalPatch<
  Key extends "bold" | "italic" | "sizePx" | "fontFamily" | "opacity",
>(target: TextStyleRun, key: Key, value: TextStylePatch[Key]): void {
  if (value === undefined) return;
  if (value === null) {
    if (key === "bold" || key === "italic") {
      Object.assign(target, { [key]: false });
    } else {
      delete target[key];
    }
    return;
  }
  // The generic key/value relationship is safe here but TS cannot preserve it
  // through an indexed assignment over optional heterogeneous properties.
  Object.assign(target, { [key]: value });
}

function normalizeRun(run: TextStyleRun): TextStyleRun {
  const next: TextStyleRun = {
    text: run.text,
    bold: Boolean(run.bold),
    italic: Boolean(run.italic),
  };
  if (run.sizePx !== undefined && Number.isFinite(run.sizePx)) {
    next.sizePx = clampFontSizePx(run.sizePx);
  }
  if (run.fontFamily && FONT_ID_PATTERN.test(run.fontFamily)) {
    next.fontFamily = run.fontFamily;
  }
  if (run.opacity !== undefined && Number.isFinite(run.opacity)) {
    next.opacity = normalizeOpacity(run.opacity);
  }
  return next;
}

function haveSameStyle(left: TextStyleRun, right: TextStyleRun): boolean {
  return (
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.sizePx === right.sizePx &&
    left.fontFamily === right.fontFamily &&
    left.opacity === right.opacity
  );
}

function normalizeOpacity(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return length;
  return Math.min(length, Math.max(0, Math.trunc(index)));
}
