import {
  measureNaturalGraphemeSlice,
  type NaturalTextMetrics,
  type NaturalWrapMode,
} from "./naturalTextLayoutMetrics";
import {
  countSemanticNaturalGraphemes,
  isNaturalPunctuationSlice,
  normalizeParagraphWhitespace,
  segmentNaturalTextGraphemes,
  skipNaturalWhitespace,
  trimNaturalWhitespace,
} from "./naturalTextLayoutSegmentation";
import type { NaturalShapeLineSlot } from "./naturalTextLayoutShape";
import {
  hasForbiddenNaturalLineEdge,
  resolveAllowedNaturalBreaks,
  resolvePreferredNaturalBreaks,
} from "./naturalTextLayoutBreaks";

export type VariableNaturalWrapResult = {
  text: string;
  cost: number;
  lineWidthsPx: number[];
};

export type VariableNaturalWrapOptions = {
  minimumLineGraphemes?: number;
};

type VariableWrapTable = {
  costs: number[][];
  next: number[][];
  widths: number[][];
};

type VariableTransition = {
  cost: number;
  next: number;
  width: number;
};

const GRAPHEME_BREAK_PENALTY = 28;
const WORD_BREAK_PENALTY = 240;
const WIDTH_EPSILON_PX = 1e-6;

/**
 * Balances one paragraph across a finite list of shape-derived line widths.
 * Every supplied slot receives exactly one non-empty line. Word mode adds
 * emergency grapheme boundaries only inside a unit wider than every slot.
 */
export function wrapNaturalTextToShapeSlots(
  text: string,
  slots: readonly NaturalShapeLineSlot[],
  metrics: NaturalTextMetrics,
  mode: NaturalWrapMode,
  locale?: string,
  options: VariableNaturalWrapOptions = {},
): VariableNaturalWrapResult | null {
  if (!hasUsableSlots(slots)) return null;
  const normalized = normalizeParagraphWhitespace(
    text.replace(/\r\n?/gu, "\n").replace(/\n/gu, " "),
  );
  if (!normalized) return null;

  const graphemes = segmentNaturalTextGraphemes(normalized);
  const visibleCount = countSemanticNaturalGraphemes(
    graphemes,
    0,
    graphemes.length,
  );
  const minimumLineGraphemes = resolveMinimumLineGraphemes(
    options.minimumLineGraphemes,
    visibleCount,
    slots.length,
  );
  if (visibleCount < slots.length * minimumLineGraphemes) return null;

  const preferred = resolvePreferredNaturalBreaks(
    normalized,
    graphemes,
    locale,
  );
  const allowed = resolveAllowedNaturalBreaks(
    graphemes,
    preferred,
    Math.max(...slots.map((slot) => slot.availableWidthPx)),
    metrics,
    mode,
  );
  const table = buildVariableWrapTable(
    graphemes,
    slots,
    allowed,
    preferred,
    metrics,
    mode,
    minimumLineGraphemes,
  );
  return reconstructVariableWrap(graphemes, slots, table);
}

function buildVariableWrapTable(
  graphemes: string[],
  slots: readonly NaturalShapeLineSlot[],
  allowed: ReadonlySet<number>,
  preferred: ReadonlySet<number>,
  metrics: NaturalTextMetrics,
  mode: NaturalWrapMode,
  minimumLineGraphemes: number,
): VariableWrapTable {
  const lineCount = slots.length;
  const graphemeCount = graphemes.length;
  const costs = Array.from({ length: lineCount + 1 }, () =>
    Array<number>(graphemeCount + 1).fill(Number.POSITIVE_INFINITY),
  );
  const next = Array.from({ length: lineCount }, () =>
    Array<number>(graphemeCount + 1).fill(-1),
  );
  const widths = Array.from({ length: lineCount }, () =>
    Array<number>(graphemeCount + 1).fill(0),
  );
  costs[lineCount][graphemeCount] = 0;

  for (let lineIndex = lineCount - 1; lineIndex >= 0; lineIndex -= 1) {
    for (let rawStart = graphemeCount - 1; rawStart >= 0; rawStart -= 1) {
      const start = skipNaturalWhitespace(graphemes, rawStart);
      const transition = findBestVariableTransition({
        allowed,
        costs,
        graphemes,
        lineIndex,
        metrics,
        minimumLineGraphemes,
        mode,
        preferred,
        slots,
        start,
      });
      if (!transition) continue;
      costs[lineIndex][rawStart] = transition.cost;
      next[lineIndex][rawStart] = transition.next;
      widths[lineIndex][rawStart] = transition.width;
    }
  }
  return { costs, next, widths };
}

function findBestVariableTransition(context: {
  allowed: ReadonlySet<number>;
  costs: number[][];
  graphemes: string[];
  lineIndex: number;
  metrics: NaturalTextMetrics;
  minimumLineGraphemes: number;
  mode: NaturalWrapMode;
  preferred: ReadonlySet<number>;
  slots: readonly NaturalShapeLineSlot[];
  start: number;
}): VariableTransition | null {
  let best: VariableTransition | null = null;
  for (
    let boundary = context.start + 1;
    boundary <= context.graphemes.length;
    boundary += 1
  ) {
    if (!context.allowed.has(boundary)) continue;
    const candidate = resolveVariableTransition(context, boundary);
    if (candidate && (!best || candidate.cost < best.cost)) {
      best = candidate;
    }
    if (isVariableBoundaryFarOverfull(context, boundary)) break;
  }
  return best;
}

function resolveVariableTransition(
  context: Parameters<typeof findBestVariableTransition>[0],
  boundary: number,
): VariableTransition | null {
  const end = trimNaturalWhitespace(context.graphemes, boundary);
  const following = skipNaturalWhitespace(context.graphemes, boundary);
  if (
    !hasValidVariableLineRange(context, end, following) ||
    hasForbiddenNaturalLineEdge(
      context.graphemes,
      context.start,
      end,
      following,
    )
  ) {
    return null;
  }
  const width = measureNaturalGraphemeSlice(
    context.graphemes,
    context.start,
    end,
    context.metrics,
  );
  const slot = context.slots[context.lineIndex];
  if (width > slot.availableWidthPx + WIDTH_EPSILON_PX) return null;
  const tailCost = context.costs[context.lineIndex + 1][following];
  if (!Number.isFinite(tailCost)) return null;
  return {
    cost:
      tailCost +
      calculateVariableLineCost(context, boundary, end, following, width),
    next: following,
    width,
  };
}

function hasValidVariableLineRange(
  context: Parameters<typeof findBestVariableTransition>[0],
  end: number,
  following: number,
): boolean {
  if (end <= context.start) return false;
  const visible = countSemanticNaturalGraphemes(
    context.graphemes,
    context.start,
    end,
  );
  if (visible < context.minimumLineGraphemes) return false;
  const isLastLine = context.lineIndex === context.slots.length - 1;
  return isLastLine
    ? following >= context.graphemes.length
    : following < context.graphemes.length;
}

function calculateVariableLineCost(
  context: Parameters<typeof findBestVariableTransition>[0],
  boundary: number,
  end: number,
  following: number,
  width: number,
): number {
  const slot = context.slots[context.lineIndex];
  const fillRatio = width / Math.max(1, slot.availableWidthPx);
  const isLastLine = context.lineIndex === context.slots.length - 1;
  let cost = (isLastLine ? 38 : 100) * (1 - fillRatio) ** 2 + 8;
  if (!context.preferred.has(boundary) && boundary < context.graphemes.length) {
    cost +=
      context.mode === "word" ? WORD_BREAK_PENALTY : GRAPHEME_BREAK_PENALTY;
  }
  if (crossesRegionAfterLine(context, boundary)) cost += 320;
  if (isNaturalPunctuationSlice(context.graphemes, context.start, end)) {
    cost += 500;
  }
  const remainingVisible = countSemanticNaturalGraphemes(
    context.graphemes,
    following,
    context.graphemes.length,
  );
  const remainingLines = context.slots.length - context.lineIndex - 1;
  if (
    remainingLines > 0 &&
    remainingVisible === remainingLines * context.minimumLineGraphemes
  ) {
    cost += 16;
  }
  return cost;
}

function crossesRegionAfterLine(
  context: Parameters<typeof findBestVariableTransition>[0],
  boundary: number,
): boolean {
  const nextSlot = context.slots[context.lineIndex + 1];
  return Boolean(
    nextSlot &&
    nextSlot.regionIndex !== context.slots[context.lineIndex].regionIndex &&
    !context.preferred.has(boundary),
  );
}

function isVariableBoundaryFarOverfull(
  context: Parameters<typeof findBestVariableTransition>[0],
  boundary: number,
): boolean {
  const end = trimNaturalWhitespace(context.graphemes, boundary);
  return (
    measureNaturalGraphemeSlice(
      context.graphemes,
      context.start,
      end,
      context.metrics,
    ) >
    context.slots[context.lineIndex].availableWidthPx * 1.15
  );
}

function reconstructVariableWrap(
  graphemes: string[],
  slots: readonly NaturalShapeLineSlot[],
  table: VariableWrapTable,
): VariableNaturalWrapResult | null {
  if (!Number.isFinite(table.costs[0]?.[0])) return null;
  const lines: string[] = [];
  const lineWidthsPx: number[] = [];
  let start = 0;
  for (let lineIndex = 0; lineIndex < slots.length; lineIndex += 1) {
    start = skipNaturalWhitespace(graphemes, start);
    const following = table.next[lineIndex]?.[start] ?? -1;
    if (following <= start) return null;
    const end = trimNaturalWhitespace(graphemes, following);
    const line = graphemes.slice(start, end).join("").trim();
    if (!line) return null;
    lines.push(line);
    lineWidthsPx.push(table.widths[lineIndex]?.[start] ?? 0);
    start = following;
  }
  if (skipNaturalWhitespace(graphemes, start) < graphemes.length) return null;
  return {
    text: lines.join("\n"),
    cost: table.costs[0][0],
    lineWidthsPx,
  };
}

function resolveMinimumLineGraphemes(
  value: number | undefined,
  visibleCount: number,
  lineCount: number,
): number {
  if (Number.isFinite(value)) {
    return Math.max(1, Math.floor(value as number));
  }
  return visibleCount >= lineCount * 3
    ? 3
    : visibleCount >= lineCount * 2
      ? 2
      : 1;
}

function hasUsableSlots(slots: readonly NaturalShapeLineSlot[]): boolean {
  return (
    slots.length > 0 &&
    slots.every(
      (slot) =>
        Number.isFinite(slot.availableWidthPx) && slot.availableWidthPx > 0,
    )
  );
}
