import {
  resizeNaturalTextMetrics,
  resolveNaturalTextMetrics,
  resolveNaturalWrapMode,
  type NaturalTextMetrics,
  type NaturalWrapMode,
} from "./naturalTextLayoutMetrics";
import {
  countSemanticNaturalGraphemes,
  segmentNaturalTextGraphemes,
} from "./naturalTextLayoutSegmentation";
import {
  resolveNaturalShapeSlotPlans,
  type NaturalShapeLineSlot,
} from "./naturalTextLayoutShape";
import {
  wrapNaturalTextToShapeSlots,
  type VariableNaturalWrapResult,
} from "./naturalTextLayoutVariableWrapping";
import type { TranslationBlock } from "./textTypes";

export type NaturalHorizontalLayoutEvaluation = {
  baselineFontSizePx?: number;
  candidateFontSizePx?: number;
  shapeAware: boolean;
  accepted?: {
    estimatedWordsPerLine: number;
    lineCount: number;
    mode: NaturalWrapMode;
    translatedText: string;
  };
};

type NaturalHorizontalCandidate = {
  estimatedWordsPerLine: number;
  fontSizePx: number;
  mode: NaturalWrapMode;
  shapeAware: boolean;
  slots: NaturalShapeLineSlot[];
  wrapped: VariableNaturalWrapResult;
};

const HORIZONTAL_SAFETY_RATIO = 0.94;
const HORIZONTAL_HEIGHT_SAFETY_RATIO = 0.96;
const MIN_GRAPHEMES_PER_HARD_LINE = 2;
const MIN_HARD_BREAK_FONT_SIZE_PX = 12;
const MAX_AUTOFIT_FONT_SIZE_PX = 256;
const MAX_NATURAL_HARD_LINES = 12;

export function evaluateNaturalHorizontalLayout(
  block: TranslationBlock,
  text: string,
  rect: { w: number; h: number },
  locale?: string,
): NaturalHorizontalLayoutEvaluation {
  const baseMetrics = resolveNaturalTextMetrics(block);
  const baseline = resolveBestHorizontalCandidate(
    block,
    text,
    rect,
    baseMetrics,
    locale,
    1,
  );
  const candidate = baseline
    ? resolveHorizontalCandidateAtFont(
        block,
        text,
        rect,
        baseMetrics,
        baseline.fontSizePx,
        locale,
        MIN_GRAPHEMES_PER_HARD_LINE,
      )
    : null;
  const evaluation: NaturalHorizontalLayoutEvaluation = {
    baselineFontSizePx: baseline?.fontSizePx,
    candidateFontSizePx: candidate?.fontSizePx,
    shapeAware: candidate?.shapeAware ?? baseline?.shapeAware ?? false,
  };
  if (
    !candidate ||
    !baseline ||
    !isReadableHardBreakCandidate(candidate, baseline)
  ) {
    return evaluation;
  }
  return {
    ...evaluation,
    accepted: {
      estimatedWordsPerLine: candidate.estimatedWordsPerLine,
      lineCount: candidate.wrapped.text.split("\n").length,
      mode: candidate.mode,
      translatedText: candidate.wrapped.text,
    },
  };
}

function resolveBestHorizontalCandidate(
  block: TranslationBlock,
  text: string,
  rect: { w: number; h: number },
  baseMetrics: NaturalTextMetrics,
  locale: string | undefined,
  minimumLineGraphemes: number,
): NaturalHorizontalCandidate | null {
  if (!(block.autoFitText ?? true)) {
    return resolveHorizontalCandidateAtFont(
      block,
      text,
      rect,
      baseMetrics,
      baseMetrics.fontSizePx,
      locale,
      minimumLineGraphemes,
    );
  }

  let low = 1;
  let high = resolveMaximumFontSize(block, rect);
  let best: NaturalHorizontalCandidate | null = null;
  while (low <= high) {
    const fontSizePx = Math.floor((low + high) / 2);
    const candidate = resolveHorizontalCandidateAtFont(
      block,
      text,
      rect,
      baseMetrics,
      fontSizePx,
      locale,
      minimumLineGraphemes,
    );
    if (candidate) {
      best = candidate;
      low = fontSizePx + 1;
    } else {
      high = fontSizePx - 1;
    }
  }
  return best;
}

function resolveMaximumFontSize(
  block: TranslationBlock,
  rect: { h: number },
): number {
  return Math.max(
    1,
    Math.min(
      MAX_AUTOFIT_FONT_SIZE_PX,
      Math.floor(
        (Math.max(1, rect.h) * HORIZONTAL_HEIGHT_SAFETY_RATIO) /
          Math.max(1, block.lineHeight || 1.18),
      ),
    ),
  );
}

function resolveHorizontalCandidateAtFont(
  block: TranslationBlock,
  text: string,
  rect: { w: number; h: number },
  baseMetrics: NaturalTextMetrics,
  fontSizePx: number,
  locale: string | undefined,
  minimumLineGraphemes: number,
): NaturalHorizontalCandidate | null {
  const metrics = resizeNaturalTextMetrics(baseMetrics, fontSizePx);
  const maximumSlotCount = resolveMaximumHardLineCount(
    text,
    minimumLineGraphemes,
  );
  const shapePlans = resolveNaturalShapeSlotPlans(block.bubbleLayout, {
    blockExtentPx: Math.max(1, rect.h) * HORIZONTAL_HEIGHT_SAFETY_RATIO,
    inlineExtentPx: Math.max(1, rect.w),
    fontSizePx,
    fontWidthScale: Math.max(0.01, metrics.fontWidthScale),
    lineHeight: Math.max(1, block.lineHeight || 1.18),
    maximumSlotCount,
  });
  const shapeAware = shapePlans.length > 0;
  const plans = shapeAware
    ? shapePlans.map((plan) => plan.slots)
    : resolveRectangularSlotPlans(
        rect,
        metrics,
        block.lineHeight,
        maximumSlotCount,
      );
  return selectBestCandidateForPlans(
    plans,
    shapeAware,
    text,
    metrics,
    fontSizePx,
    locale,
    minimumLineGraphemes,
  );
}

function selectBestCandidateForPlans(
  plans: readonly NaturalShapeLineSlot[][],
  shapeAware: boolean,
  text: string,
  metrics: NaturalTextMetrics,
  fontSizePx: number,
  locale: string | undefined,
  minimumLineGraphemes: number,
): NaturalHorizontalCandidate | null {
  let best: NaturalHorizontalCandidate | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const slots of plans) {
    const modeDecision = resolveNaturalWrapMode(
      text,
      resolveRepresentativeSlotWidth(slots),
      metrics,
      locale,
    );
    const wrapped = wrapNaturalTextToShapeSlots(
      text,
      slots,
      metrics,
      modeDecision.mode,
      locale,
      { minimumLineGraphemes },
    );
    if (!wrapped) continue;
    const coveredRegions = new Set(slots.map((slot) => slot.regionIndex)).size;
    const score =
      wrapped.cost +
      slots.length * 0.5 -
      (shapeAware ? coveredRegions * 18 : 0);
    if (score >= bestScore) continue;
    bestScore = score;
    best = {
      estimatedWordsPerLine: modeDecision.estimatedWordsPerLine,
      fontSizePx,
      mode: modeDecision.mode,
      shapeAware,
      slots,
      wrapped,
    };
  }
  return best;
}

function resolveRectangularSlotPlans(
  rect: { w: number; h: number },
  metrics: NaturalTextMetrics,
  lineHeight: number,
  maximumSlotCount: number,
): NaturalShapeLineSlot[][] {
  const lineHeightPx = metrics.fontSizePx * Math.max(1, lineHeight || 1.18);
  const maximumLineCount = Math.min(
    maximumSlotCount,
    Math.floor(
      (Math.max(1, rect.h) * HORIZONTAL_HEIGHT_SAFETY_RATIO) /
        Math.max(1, lineHeightPx),
    ),
  );
  const availableWidthPx =
    (Math.max(1, rect.w) * HORIZONTAL_SAFETY_RATIO) /
    Math.max(0.01, metrics.fontWidthScale);
  return Array.from({ length: maximumLineCount }, (_, index) =>
    Array.from({ length: index + 1 }, () => ({
      availableWidthPx,
      regionIndex: 0,
    })),
  );
}

function resolveMaximumHardLineCount(
  text: string,
  minimumLineGraphemes: number,
): number {
  const graphemes = segmentNaturalTextGraphemes(text);
  const visibleCount = countSemanticNaturalGraphemes(
    graphemes,
    0,
    graphemes.length,
  );
  return Math.max(
    1,
    Math.min(
      MAX_NATURAL_HARD_LINES,
      Math.floor(visibleCount / Math.max(1, minimumLineGraphemes)),
    ),
  );
}

function resolveRepresentativeSlotWidth(
  slots: readonly NaturalShapeLineSlot[],
): number {
  const widths = slots
    .map((slot) => slot.availableWidthPx)
    .sort((left, right) => left - right);
  return widths.at(Math.floor(Math.max(0, widths.length - 1) * 0.75)) ?? 1;
}

function isReadableHardBreakCandidate(
  candidate: NaturalHorizontalCandidate,
  baseline: NaturalHorizontalCandidate,
): boolean {
  const lines = candidate.wrapped.text.split("\n");
  return (
    lines.length >= 2 &&
    lines.length <= MAX_NATURAL_HARD_LINES &&
    candidate.fontSizePx >= MIN_HARD_BREAK_FONT_SIZE_PX &&
    candidate.fontSizePx >= baseline.fontSizePx &&
    !hasUnreadablyShortHardLine(candidate.wrapped.text) &&
    candidate.slots.every((slot, index) => {
      const width = candidate.wrapped.lineWidthsPx[index];
      return Number.isFinite(width) && width <= slot.availableWidthPx + 1e-6;
    })
  );
}

function hasUnreadablyShortHardLine(value: string): boolean {
  return hasHardLineShorterThan(value, MIN_GRAPHEMES_PER_HARD_LINE);
}

function hasHardLineShorterThan(
  value: string,
  minimumGraphemes: number,
): boolean {
  const lines = value.replace(/\r\n?/gu, "\n").split("\n");
  return (
    lines.length > 1 &&
    lines.some((line) => {
      const graphemes = segmentNaturalTextGraphemes(line);
      return (
        countSemanticNaturalGraphemes(graphemes, 0, graphemes.length) <
        minimumGraphemes
      );
    })
  );
}
