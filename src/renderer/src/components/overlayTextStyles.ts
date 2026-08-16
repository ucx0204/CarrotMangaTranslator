import type React from "react";
import type {
  RenderTextDirection,
  TranslationBlock,
} from "../../../shared/textTypes";
import {
  resolveEffectiveTextColor,
  resolveEffectiveTextOutlineColor,
  resolveEffectiveTextOutlineWidthPx,
} from "../../../shared/textOutline";
import {
  resolveBlockTextWordBreak,
  type TextWordBreak,
} from "../../../shared/textWrapping";
import { resolveBlockFontFamily, type BlockFontCatalog } from "../lib/fonts";
import { resolveFontWidthScale } from "../lib/blockFormatGeometry";
import type { BlockTextLayout } from "../lib/overlayLayout";

export function resolveOverlayTextWrapStyle(
  block: TranslationBlock,
  layout: BlockTextLayout,
  fontCatalog: BlockFontCatalog,
): React.CSSProperties {
  return {
    bottom: "auto",
    color: resolveEffectiveTextColor(block),
    fontFamily: resolveBlockFontFamily(block.fontFamily, fontCatalog),
    fontSize: `${layout.fontSizePx}px`,
    height: `${layout.layoutHeight}px`,
    left: 0,
    lineHeight: block.lineHeight,
    letterSpacing: block.letterSpacing ? `${block.letterSpacing}em` : undefined,
    right: "auto",
    opacity: normalizeTextOpacity(block.textOpacity),
    textAlign: block.textAlign,
    top: 0,
    transform:
      layout.textScaleX === 1 && layout.textScaleY === 1
        ? undefined
        : `scale(${layout.textScaleX}, ${layout.textScaleY})`,
    transformOrigin: "top left",
    width: `${layout.layoutWidth}px`,
  };
}

export function resolveOverlayTextContentStyle(
  block: TranslationBlock,
  layout: BlockTextLayout,
  renderDirection: RenderTextDirection,
): React.CSSProperties {
  const scaleX = resolveFontWidthScale(block.fontWidthScale);
  const hasBubbleSlots = Boolean(
    layout.lines?.some((line) => line.slot !== undefined),
  );
  const breakStyle = resolveWordBreakCss(
    resolveBlockTextWordBreak(block.wordBreak, renderDirection),
  );
  const geometryStyle = resolveTextContentGeometryStyle(
    hasBubbleSlots,
    layout,
    renderDirection,
    block.textAlign,
  );
  return {
    boxSizing: "border-box",
    writingMode:
      renderDirection === "vertical" ? "vertical-rl" : "horizontal-tb",
    textOrientation: renderDirection === "vertical" ? "upright" : undefined,
    width:
      renderDirection === "vertical"
        ? hasBubbleSlots
          ? `${layout.fitInnerWidth / scaleX}px`
          : "max-content"
        : `${layout.textContentWidth}px`,
    ...geometryStyle,
    maxHeight: "100%",
    overflow: "visible",
    // Horizontal text is already split into deterministic fixed lines, but
    // retaining the selected values here keeps computed styles truthful. For
    // vertical text these properties perform the browser-side column breaks.
    overflowWrap: breakStyle.overflowWrap,
    wordBreak: breakStyle.wordBreak,
    whiteSpace: layout.lines ? "normal" : undefined,
    fontWeight: block.bold ? 800 : 400,
    fontStyle: block.italic ? "italic" : "normal",
    fontSynthesis: "weight style",
    ...resolveBlockTextOutlineCss(block, layout.fontSizePx),
    transform: scaleX === 1 ? undefined : `scaleX(${scaleX})`,
  };
}

function resolveTextContentGeometryStyle(
  hasBubbleSlots: boolean,
  layout: BlockTextLayout,
  renderDirection: RenderTextDirection,
  textAlign: TranslationBlock["textAlign"],
): Pick<
  React.CSSProperties,
  "flexShrink" | "height" | "maxWidth" | "position" | "transformOrigin"
> {
  if (hasBubbleSlots) {
    return {
      flexShrink: 0,
      height: `${layout.fitInnerHeight}px`,
      maxWidth: "none",
      position: "relative",
      transformOrigin: "center center",
    };
  }
  return {
    height:
      renderDirection === "vertical" ? `${layout.fitInnerHeight}px` : undefined,
    maxWidth: "100%",
    transformOrigin: resolveFontWidthOrigin(renderDirection, textAlign),
  };
}

function resolveWordBreakCss(wordBreak: TextWordBreak): {
  overflowWrap: React.CSSProperties["overflowWrap"];
  wordBreak: React.CSSProperties["wordBreak"];
} {
  if (wordBreak === "break-word") {
    return { overflowWrap: "anywhere", wordBreak };
  }
  return { overflowWrap: "normal", wordBreak };
}

export function normalizeTextOpacity(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value as number));
}

export function resolveBlockTextOutlinePx(
  block: TranslationBlock,
  fontSizePx: number,
): number {
  return resolveEffectiveTextOutlineWidthPx(block, fontSizePx);
}

function resolveBlockTextOutlineCss(
  block: TranslationBlock,
  fontSizePx: number,
): Pick<
  React.CSSProperties,
  | "WebkitTextStrokeColor"
  | "WebkitTextStrokeWidth"
  | "paintOrder"
  | "textShadow"
> {
  const width = resolveBlockTextOutlinePx(block, fontSizePx);
  return {
    textShadow: "none",
    WebkitTextStrokeColor:
      width > 0 ? resolveEffectiveTextOutlineColor(block) : "transparent",
    // CSS/SVG strokes are centered on the glyph path. Doubling the stored
    // outward thickness keeps the visible outline equal to the requested px.
    WebkitTextStrokeWidth: `${width * 2}px`,
    paintOrder: "stroke fill",
  };
}

function resolveFontWidthOrigin(
  renderDirection: RenderTextDirection,
  textAlign: TranslationBlock["textAlign"],
): string {
  if (renderDirection === "vertical") return "center center";
  if (textAlign === "left") return "left center";
  if (textAlign === "right") return "right center";
  return "center center";
}
