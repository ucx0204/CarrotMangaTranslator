import { isUsableBubbleLayout } from "./bubbleLayout";
import {
  bboxToPixels,
  resolveBlockRenderBbox,
  resolveEffectiveRenderBbox,
} from "./geometry";
import { evaluateNaturalHorizontalLayout } from "./naturalTextLayoutHorizontal";
import {
  resolveNaturalVerticalDecision,
  roundNaturalMetric,
} from "./naturalTextLayoutMetrics";
import { segmentNaturalTextGraphemes } from "./naturalTextLayoutSegmentation";
import { stripRichTextMarkup } from "./richTextMarkup";
import type { RenderTextDirection, TranslationBlock } from "./textTypes";

type NaturalTextLayoutStrategy =
  | "disabled"
  | "unchanged"
  | "markup-preserved"
  | "vertical"
  | "word"
  | "grapheme";

export type NaturalTextLayoutOptions = {
  enabled?: boolean;
  pageSize: { width: number; height: number };
  locale?: string;
  /**
   * Automatic vertical writing is intended only for freshly detected ordinary
   * text. Existing blocks, sound effects, and curved text pass false.
   */
  allowAutoVertical?: boolean;
  /** Explicit user defaults always win over automatic direction selection. */
  directionPreference?: "auto" | "horizontal" | "vertical";
  /** Transient font-file width estimate used only by this layout pass. */
  fontMetricWidthScale?: number;
};

type NaturalTextLayoutDiagnostics = {
  widthPx: number;
  heightPx: number;
  graphemeCount: number;
  estimatedWordsPerLine: number;
  lineCount: number;
  autoVerticalEligible: boolean;
  oneColumnMaxFontPx?: number;
  twoColumnMaxFontPx?: number;
  estimatedFontSizePx?: number;
  baselineEstimatedFontSizePx?: number;
  shapeAware?: boolean;
};

export type NaturalTextLayoutResult = {
  translatedText: string;
  renderDirection: RenderTextDirection;
  strategy: NaturalTextLayoutStrategy;
  changed: boolean;
  diagnostics: NaturalTextLayoutDiagnostics;
};

export function applyNaturalTextLayout(
  block: TranslationBlock,
  options: NaturalTextLayoutOptions,
): NaturalTextLayoutResult {
  const text = String(block.translatedText ?? "");
  const baseRect = resolveNaturalLayoutRect(
    block,
    options.pageSize,
    text,
    false,
  );
  const diagnostics = buildBaseDiagnostics(text, baseRect);
  if (!options.enabled || !text.trim()) {
    return unchangedResult(
      block,
      text,
      options.enabled ? "unchanged" : "disabled",
      diagnostics,
    );
  }
  if (stripRichTextMarkup(text) !== text) {
    return unchangedResult(block, text, "markup-preserved", diagnostics);
  }
  if (/[\r\n]/u.test(text) || hasMeaningfulWhitespaceFormatting(text)) {
    return unchangedResult(block, text, "unchanged", diagnostics);
  }

  const vertical = resolveNaturalVerticalDecision(
    block,
    text,
    baseRect,
    options,
  );
  const withVerticalMetrics = {
    ...diagnostics,
    autoVerticalEligible: vertical.eligible,
    oneColumnMaxFontPx: vertical.oneColumnMaxFontPx,
    twoColumnMaxFontPx: vertical.twoColumnMaxFontPx,
  };
  if (vertical.eligible) {
    return verticalResult(block, text, withVerticalMetrics);
  }
  if (
    shouldPreserveVertical(block, options) ||
    !supportsNaturalHardBreaks(block)
  ) {
    return unchangedResult(block, text, "unchanged", withVerticalMetrics);
  }

  const horizontalRect = resolveNaturalLayoutRect(
    block,
    options.pageSize,
    text,
    true,
  );
  return resolveHorizontalResult(
    block,
    text,
    horizontalRect,
    options.locale,
    options.fontMetricWidthScale,
    {
      ...withVerticalMetrics,
      widthPx: horizontalRect.w,
      heightPx: horizontalRect.h,
    },
  );
}

function resolveHorizontalResult(
  block: TranslationBlock,
  text: string,
  rect: { w: number; h: number },
  locale: string | undefined,
  fontMetricWidthScale: number | undefined,
  diagnostics: NaturalTextLayoutDiagnostics,
): NaturalTextLayoutResult {
  const evaluation = evaluateNaturalHorizontalLayout(
    block,
    text,
    rect,
    locale,
    fontMetricWidthScale,
  );
  const measuredDiagnostics = {
    ...diagnostics,
    baselineEstimatedFontSizePx:
      evaluation.baselineFontSizePx === undefined
        ? undefined
        : roundNaturalMetric(evaluation.baselineFontSizePx),
    estimatedFontSizePx:
      evaluation.candidateFontSizePx === undefined
        ? undefined
        : roundNaturalMetric(evaluation.candidateFontSizePx),
    shapeAware: evaluation.shapeAware,
  };
  if (!evaluation.accepted) {
    return unchangedResult(block, text, "unchanged", measuredDiagnostics);
  }
  const completeDiagnostics = {
    ...measuredDiagnostics,
    estimatedWordsPerLine: roundNaturalMetric(
      evaluation.accepted.estimatedWordsPerLine,
    ),
    lineCount: evaluation.accepted.lineCount,
  };
  if (evaluation.accepted.translatedText === text) {
    return unchangedResult(block, text, "unchanged", completeDiagnostics);
  }
  return {
    translatedText: evaluation.accepted.translatedText,
    renderDirection: block.renderDirection,
    strategy: evaluation.accepted.mode,
    changed: true,
    diagnostics: completeDiagnostics,
  };
}

function resolveNaturalLayoutRect(
  block: TranslationBlock,
  pageSize: NaturalTextLayoutOptions["pageSize"],
  text: string,
  effective: boolean,
): { w: number; h: number } {
  const rect = bboxToPixels(
    effective && !isUsableBubbleLayout(block.bubbleLayout)
      ? resolveEffectiveRenderBbox(block, pageSize, text)
      : resolveBlockRenderBbox(block, pageSize),
    pageSize.width,
    pageSize.height,
  );
  return { w: rect.w, h: rect.h };
}

function buildBaseDiagnostics(
  text: string,
  rect: { w: number; h: number },
): NaturalTextLayoutDiagnostics {
  const normalized = text.replace(/\r\n?/gu, "\n");
  return {
    widthPx: rect.w,
    heightPx: rect.h,
    graphemeCount: segmentNaturalTextGraphemes(normalized).filter(
      (value) => value !== "\n",
    ).length,
    estimatedWordsPerLine: 0,
    lineCount: countNaturalLines(normalized),
    autoVerticalEligible: false,
  };
}

function verticalResult(
  block: TranslationBlock,
  text: string,
  diagnostics: NaturalTextLayoutDiagnostics,
): NaturalTextLayoutResult {
  return {
    translatedText: text,
    renderDirection: "vertical",
    strategy: "vertical",
    changed: block.renderDirection !== "vertical",
    diagnostics,
  };
}

function unchangedResult(
  block: TranslationBlock,
  text: string,
  strategy: NaturalTextLayoutStrategy,
  diagnostics: NaturalTextLayoutDiagnostics,
): NaturalTextLayoutResult {
  return {
    translatedText: text,
    renderDirection: block.renderDirection,
    strategy,
    changed: false,
    diagnostics,
  };
}

function shouldPreserveVertical(
  block: TranslationBlock,
  options: NaturalTextLayoutOptions,
): boolean {
  return (
    options.directionPreference === "vertical" ||
    block.renderDirection === "vertical"
  );
}

function supportsNaturalHardBreaks(block: TranslationBlock): boolean {
  return (
    block.wordBreak === undefined ||
    block.wordBreak === "normal" ||
    block.wordBreak === "break-all" ||
    block.wordBreak === "break-word" ||
    block.wordBreak === "keep-all"
  );
}

function countNaturalLines(value: string): number {
  return Math.max(1, value.replace(/\r\n?/gu, "\n").split("\n").length);
}

function hasMeaningfulWhitespaceFormatting(value: string): boolean {
  return value !== value.trim() || /\t|\u00a0| {2,}/u.test(value);
}

export { segmentNaturalTextGraphemes };
