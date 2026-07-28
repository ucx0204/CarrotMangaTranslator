import {
  hasForbiddenNaturalLineEdge,
  resolveAllowedNaturalBreaks,
  resolvePreferredNaturalBreaks,
} from "./naturalTextLayoutBreaks";
import {
  measureNaturalGraphemeSlice,
  measureNaturalText,
  type NaturalTextMetrics,
  type NaturalWrapMode,
} from "./naturalTextLayoutMetrics";
import {
  CLOSING_PUNCTUATION,
  countSemanticNaturalGraphemes,
  isNaturalPunctuationSlice,
  normalizeParagraphWhitespace,
  segmentNaturalTextGraphemes,
  skipNaturalWhitespace,
  trimNaturalWhitespace,
} from "./naturalTextLayoutSegmentation";

type UniformWrapTable = {
  costs: number[];
  next: number[];
};

type UniformTransition = {
  cost: number;
  next: number;
};

const GRAPHEME_BREAK_PENALTY = 28;
const WORD_BREAK_PENALTY = 240;

export function wrapNaturalText(
  text: string,
  maxWidth: number,
  metrics: NaturalTextMetrics,
  mode: NaturalWrapMode,
  locale?: string,
): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((paragraph) =>
      wrapNaturalParagraph(paragraph, maxWidth, metrics, mode, locale),
    )
    .join("\n");
}

function wrapNaturalParagraph(
  paragraph: string,
  maxWidth: number,
  metrics: NaturalTextMetrics,
  mode: NaturalWrapMode,
  locale?: string,
): string {
  if (!paragraph.trim()) return paragraph;
  const normalized = normalizeParagraphWhitespace(paragraph);
  if (measureNaturalText(normalized, metrics) <= maxWidth) return paragraph;
  const graphemes = segmentNaturalTextGraphemes(normalized);
  if (graphemes.length <= 1) return paragraph;

  const preferred = resolvePreferredNaturalBreaks(
    normalized,
    graphemes,
    locale,
  );
  const allowed = resolveAllowedNaturalBreaks(
    graphemes,
    preferred,
    maxWidth,
    metrics,
    mode,
  );
  const table = buildUniformWrapTable(
    graphemes,
    allowed,
    preferred,
    maxWidth,
    metrics,
    mode,
  );
  return reconstructUniformLines(graphemes, table, maxWidth, metrics);
}

function buildUniformWrapTable(
  graphemes: string[],
  allowed: ReadonlySet<number>,
  preferred: ReadonlySet<number>,
  maxWidth: number,
  metrics: NaturalTextMetrics,
  mode: NaturalWrapMode,
): UniformWrapTable {
  const count = graphemes.length;
  const costs = Array<number>(count + 1).fill(Number.POSITIVE_INFINITY);
  const next = Array<number>(count + 1).fill(-1);
  const minimumLineGraphemes =
    countSemanticNaturalGraphemes(graphemes, 0, count) >= 6 ? 3 : 1;
  costs[count] = 0;
  for (let rawStart = count - 1; rawStart >= 0; rawStart -= 1) {
    const start = skipNaturalWhitespace(graphemes, rawStart);
    if (start !== rawStart) {
      costs[rawStart] = costs[start];
      next[rawStart] = next[start];
      continue;
    }
    const transition = findBestUniformTransition({
      allowed,
      costs,
      graphemes,
      maxWidth,
      metrics,
      minimumLineGraphemes,
      mode,
      preferred,
      start,
    });
    if (!transition) continue;
    costs[start] = transition.cost;
    next[start] = transition.next;
  }
  return { costs, next };
}

function findBestUniformTransition(context: {
  allowed: ReadonlySet<number>;
  costs: number[];
  graphemes: string[];
  maxWidth: number;
  metrics: NaturalTextMetrics;
  minimumLineGraphemes: number;
  mode: NaturalWrapMode;
  preferred: ReadonlySet<number>;
  start: number;
}): UniformTransition | null {
  let best: UniformTransition | null = null;
  for (
    let boundary = context.start + 1;
    boundary <= context.graphemes.length;
    boundary += 1
  ) {
    if (!context.allowed.has(boundary)) continue;
    const candidate = resolveUniformTransition(context, boundary);
    if (candidate && (!best || candidate.cost < best.cost)) {
      best = candidate;
    }
    if (isUniformBoundaryFarOverfull(context, boundary)) break;
  }
  return best;
}

function resolveUniformTransition(
  context: Parameters<typeof findBestUniformTransition>[0],
  boundary: number,
): UniformTransition | null {
  const end = trimNaturalWhitespace(context.graphemes, boundary);
  if (end <= context.start) return null;
  const lineLength = countSemanticNaturalGraphemes(
    context.graphemes,
    context.start,
    end,
  );
  if (lineLength < context.minimumLineGraphemes) return null;
  const following = skipNaturalWhitespace(context.graphemes, boundary);
  if (
    hasForbiddenNaturalLineEdge(
      context.graphemes,
      context.start,
      end,
      following,
    ) ||
    !Number.isFinite(context.costs[following])
  ) {
    return null;
  }
  const width = measureNaturalGraphemeSlice(
    context.graphemes,
    context.start,
    end,
    context.metrics,
  );
  const overfull = width > context.maxWidth;
  if (
    overfull &&
    !isClosingPunctuationAttachment(
      context.graphemes,
      context.start,
      end,
      context.maxWidth,
      context.metrics,
    )
  ) {
    return null;
  }
  return {
    cost:
      context.costs[following] +
      calculateUniformLineCost(
        context,
        boundary,
        end,
        following,
        width,
        overfull,
      ),
    next: following,
  };
}

function calculateUniformLineCost(
  context: Parameters<typeof findBestUniformTransition>[0],
  boundary: number,
  end: number,
  following: number,
  width: number,
  overfull: boolean,
): number {
  const isLast = following >= context.graphemes.length;
  const slackRatio = Math.max(0, context.maxWidth - width) / context.maxWidth;
  let cost = (isLast ? 16 : 100) * slackRatio ** 2 + 12;
  if (!context.preferred.has(boundary) && boundary < context.graphemes.length) {
    cost +=
      context.mode === "word" ? WORD_BREAK_PENALTY : GRAPHEME_BREAK_PENALTY;
  }
  if (isNaturalPunctuationSlice(context.graphemes, context.start, end)) {
    cost += 500;
  }
  if (overfull) cost += 800;
  return cost;
}

function reconstructUniformLines(
  graphemes: string[],
  table: UniformWrapTable,
  maxWidth: number,
  metrics: NaturalTextMetrics,
): string {
  if (!Number.isFinite(table.costs[0]) || table.next[0] < 0) {
    return greedyNaturalFallback(graphemes, maxWidth, metrics);
  }
  const lines: string[] = [];
  let start = 0;
  while (start < graphemes.length) {
    const following = table.next[start];
    if (following <= start) {
      return greedyNaturalFallback(graphemes, maxWidth, metrics);
    }
    const end = trimNaturalWhitespace(graphemes, following);
    lines.push(graphemes.slice(start, end).join("").trim());
    start = skipNaturalWhitespace(graphemes, following);
  }
  return lines.filter(Boolean).join("\n");
}

function isUniformBoundaryFarOverfull(
  context: Parameters<typeof findBestUniformTransition>[0],
  boundary: number,
): boolean {
  return (
    measureNaturalGraphemeSlice(
      context.graphemes,
      context.start,
      trimNaturalWhitespace(context.graphemes, boundary),
      context.metrics,
    ) >
    context.maxWidth * 1.6
  );
}

function isClosingPunctuationAttachment(
  graphemes: string[],
  start: number,
  end: number,
  maxWidth: number,
  metrics: NaturalTextMetrics,
): boolean {
  return (
    end - start > 1 &&
    CLOSING_PUNCTUATION.includes(graphemes[end - 1]) &&
    measureNaturalGraphemeSlice(graphemes, start, end - 1, metrics) <= maxWidth
  );
}

function greedyNaturalFallback(
  graphemes: string[],
  maxWidth: number,
  metrics: NaturalTextMetrics,
): string {
  const lines: string[] = [];
  let start = 0;
  while (start < graphemes.length) {
    start = skipNaturalWhitespace(graphemes, start);
    if (start >= graphemes.length) break;
    const end = findGreedyEnd(graphemes, start, maxWidth, metrics);
    lines.push(graphemes.slice(start, end).join("").trim());
    start = end;
  }
  return lines.filter(Boolean).join("\n");
}

function findGreedyEnd(
  graphemes: string[],
  start: number,
  maxWidth: number,
  metrics: NaturalTextMetrics,
): number {
  let end = start + 1;
  while (
    end < graphemes.length &&
    measureNaturalGraphemeSlice(graphemes, start, end + 1, metrics) <= maxWidth
  ) {
    end += 1;
  }
  while (
    end < graphemes.length &&
    CLOSING_PUNCTUATION.includes(graphemes[end])
  ) {
    end += 1;
  }
  return end;
}
