import type React from "react";
import type { TextStyleRun } from "../../../shared/richTextMarkup";
import {
  resolveTextGlow,
  resolveTextGlowCssShadow,
} from "../../../shared/textGlow";
import {
  resolveEffectiveTextColor,
  resolveEffectiveTextOutlineColor,
  resolveEffectiveTextOutlineWidthPx,
} from "../../../shared/textOutline";
import type {
  RenderTextDirection,
  TranslationBlock,
} from "../../../shared/textTypes";

const DEFAULT_OUTER_OUTLINE_COLOR = "#111111";

export function resolveMainRunVisualStyle(
  block: TranslationBlock,
  run: TextStyleRun,
  renderedBaseFontSizePx: number,
  renderDirection: RenderTextDirection,
): React.CSSProperties {
  const scale = resolveInlineScale(block, renderedBaseFontSizePx);
  const outlineWidth = resolveRunOutlineWidth(
    block,
    run,
    renderedBaseFontSizePx,
    scale,
  );
  return {
    color: run.color ?? resolveEffectiveTextColor(block),
    backgroundColor: run.backgroundColor,
    WebkitTextStrokeColor:
      outlineWidth > 0
        ? (run.outlineColor ?? resolveEffectiveTextOutlineColor(block))
        : "transparent",
    WebkitTextStrokeWidth: `${outlineWidth * 2}px`,
    paintOrder: "stroke fill",
    ...resolveTextDecorationStyle(block, run),
    ...resolveTextEmphasisStyle(block, run, renderDirection),
    textShadow: resolveRunGlow(block, run, scale),
    ...resolveWidthScaleStyle(run.widthScale),
  } as React.CSSProperties;
}

function resolveRunOutlineWidth(
  block: TranslationBlock,
  run: TextStyleRun,
  renderedBaseFontSizePx: number,
  scale: number,
): number {
  return run.outlineWidthPx === undefined
    ? resolveEffectiveTextOutlineWidthPx(block, renderedBaseFontSizePx)
    : run.outlineWidthPx * scale;
}

function resolveTextDecorationStyle(
  block: TranslationBlock,
  run: TextStyleRun,
): React.CSSProperties {
  const lines = [
    block.underline || run.underline ? "underline" : "",
    block.strikethrough || run.strikethrough ? "line-through" : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (!lines) return {};
  return {
    textDecorationLine: lines,
    textDecorationColor: "currentColor",
    textDecorationThickness: "0.08em",
    textUnderlineOffset: "0.12em",
  };
}

function resolveTextEmphasisStyle(
  block: TranslationBlock,
  run: TextStyleRun,
  renderDirection: RenderTextDirection,
): React.CSSProperties {
  if (!block.emphasisMark && !run.emphasisMark) return {};
  return {
    textEmphasisStyle: "filled dot",
    textEmphasisColor: "currentColor",
    textEmphasisPosition:
      renderDirection === "vertical" ? "over right" : "over",
  } as React.CSSProperties;
}

function resolveWidthScaleStyle(widthScale = 1): React.CSSProperties {
  return widthScale === 1
    ? {}
    : { fontStretch: `${Math.round(widthScale * 1_000) / 10}%` };
}

export function resolveOuterRunVisualStyle(
  block: TranslationBlock,
  run: TextStyleRun,
  renderedBaseFontSizePx: number,
): React.CSSProperties | null {
  const scale = resolveInlineScale(block, renderedBaseFontSizePx);
  const innerWidth =
    run.outlineWidthPx === undefined
      ? resolveEffectiveTextOutlineWidthPx(block, renderedBaseFontSizePx)
      : run.outlineWidthPx * scale;
  const outerWidth =
    run.outerOutlineWidthPx === undefined
      ? Math.max(0, block.outerOutlineWidthPx ?? 0)
      : run.outerOutlineWidthPx * scale;
  if (outerWidth <= 0) return null;
  const color =
    run.outerOutlineColor ??
    block.outerOutlineColor ??
    DEFAULT_OUTER_OUTLINE_COLOR;
  const widthScale = run.widthScale ?? 1;
  return {
    color: "transparent",
    WebkitTextFillColor: "transparent",
    WebkitTextStrokeColor: color,
    WebkitTextStrokeWidth: `${(innerWidth + outerWidth) * 2}px`,
    paintOrder: "stroke fill",
    ...(widthScale === 1
      ? {}
      : { fontStretch: `${Math.round(widthScale * 1_000) / 10}%` }),
  } as React.CSSProperties;
}

export function hasAnyOuterOutline(
  block: TranslationBlock,
  runs: readonly TextStyleRun[],
): boolean {
  return (
    Math.max(0, block.outerOutlineWidthPx ?? 0) > 0 ||
    runs.some((run) => Math.max(0, run.outerOutlineWidthPx ?? 0) > 0)
  );
}

function resolveRunGlow(
  block: TranslationBlock,
  run: TextStyleRun,
  scale: number,
): string | undefined {
  const hasInlineGlow =
    run.glowColor !== undefined ||
    run.glowBlurPx !== undefined ||
    run.glowOpacity !== undefined;
  if (!hasInlineGlow) return resolveTextGlowCssShadow(block.textGlow, scale);
  const base = resolveTextGlow(block.textGlow);
  return resolveTextGlowCssShadow(
    {
      enabled: true,
      color: run.glowColor ?? base.color,
      blurPx: run.glowBlurPx ?? base.blurPx,
      opacity: run.glowOpacity ?? base.opacity,
    },
    scale,
  );
}

function resolveInlineScale(
  block: TranslationBlock,
  renderedBaseFontSizePx: number,
): number {
  return renderedBaseFontSizePx / Math.max(1, block.fontSizePx || 1);
}
