import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import { resolveBlockVisualStyle } from "../../../shared/blockVisuals";
import { normalizeRenderDirection } from "../../../shared/geometry";
import { resolveBlockFontFamily } from "../lib/fonts";
import {
  hexToRgba,
  resolveBlockTextLayout,
  type ViewportSize,
} from "../lib/overlayLayout";

type OverlayBlockProps = {
  block: TranslationBlock;
  pageSize: ViewportSize;
  stageSize: ViewportSize;
  selected: boolean;
  multiSelected?: boolean;
  showChrome: boolean;
  showExcluded?: boolean;
  pointerDisabled?: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onResizePointerDown: (event: React.PointerEvent) => void;
  onToggleExcluded?: () => void;
};

export function OverlayBlock({
  block,
  pageSize,
  stageSize,
  selected,
  multiSelected = false,
  showChrome,
  showExcluded = false,
  pointerDisabled = false,
  onPointerDown,
  onResizePointerDown,
  onToggleExcluded,
}: OverlayBlockProps): React.JSX.Element | null {
  const displayText = block.translatedText || block.sourceText || "...";
  const layout = resolveBlockTextLayout(
    block,
    displayText,
    pageSize,
    stageSize,
  );
  const renderDirection = normalizeRenderDirection(
    block.renderDirection,
    "horizontal",
  );
  const excluded = showExcluded && Boolean(block.inpaintExcluded);

  return (
    <div
      className={resolveOverlayBlockClassName(
        block.type,
        selected,
        multiSelected,
        excluded,
        showChrome,
      )}
      style={resolveOverlayBlockStyle(block, layout, pointerDisabled)}
      onPointerDown={pointerDisabled ? undefined : onPointerDown}
    >
      {showChrome || excluded ? (
        <div
          className="overlay-block-chrome"
          style={resolveOverlayChromeStyle(block, showChrome, excluded)}
        />
      ) : null}
      <OverlayText
        block={block}
        displayText={displayText}
        layout={layout}
        renderDirection={renderDirection}
      />
      <OverlayExcludeControl
        block={block}
        excluded={excluded}
        onToggleExcluded={onToggleExcluded}
        pointerDisabled={pointerDisabled}
        showExcluded={showExcluded}
      />
      <OverlayResizeHandle
        onResizePointerDown={onResizePointerDown}
        pointerDisabled={pointerDisabled}
        selected={selected}
      />
    </div>
  );
}

function OverlayText({
  block,
  displayText,
  layout,
  renderDirection,
}: {
  block: TranslationBlock;
  displayText: string;
  layout: ReturnType<typeof resolveBlockTextLayout>;
  renderDirection: ReturnType<typeof normalizeRenderDirection>;
}): React.JSX.Element {
  return (
    <div
      className="overlay-text"
      style={resolveOverlayTextWrapStyle(block, layout)}
    >
      <span
        className="overlay-text-content"
        style={resolveOverlayTextContentStyle(block, layout, renderDirection)}
      >
        {displayText}
      </span>
    </div>
  );
}

function OverlayExcludeControl({
  block,
  excluded,
  onToggleExcluded,
  pointerDisabled,
  showExcluded,
}: {
  block: TranslationBlock;
  excluded: boolean;
  onToggleExcluded: (() => void) | undefined;
  pointerDisabled: boolean;
  showExcluded: boolean;
}): React.JSX.Element | null {
  if (!showExcluded) {
    return null;
  }
  if (onToggleExcluded && !pointerDisabled) {
    return (
      <button
        type="button"
        className={`overlay-exclude-toggle ${block.inpaintExcluded ? "excluded" : ""}`}
        title={resolveExcludeToggleTitle(block.inpaintExcluded)}
        onPointerDown={stopOverlayControlEvent}
        onClick={(event) => {
          stopOverlayControlEvent(event);
          onToggleExcluded();
        }}
      >
        {block.inpaintExcluded ? "제외됨" : "제외"}
      </button>
    );
  }
  return excluded ? (
    <span className="overlay-excluded-badge" aria-hidden="true">
      제외
    </span>
  ) : null;
}

function OverlayResizeHandle({
  onResizePointerDown,
  pointerDisabled,
  selected,
}: {
  onResizePointerDown: (event: React.PointerEvent) => void;
  pointerDisabled: boolean;
  selected: boolean;
}): React.JSX.Element | null {
  return selected && !pointerDisabled ? (
    <button
      className="resize-handle"
      onPointerDown={onResizePointerDown}
      aria-label="Resize"
    />
  ) : null;
}

// The block element owns only position, size, rotation, and the pointer
// hitbox. Editor chrome (border/background) lives in a separate absolute layer
// so toggling it never perturbs the text content box. Outline is a text-shadow
// effect on the content and likewise never affects layout.
function resolveOverlayBlockStyle(
  block: TranslationBlock,
  layout: ReturnType<typeof resolveBlockTextLayout>,
  pointerDisabled: boolean,
): React.CSSProperties {
  return {
    left: layout.rect.left,
    top: layout.rect.top,
    width: layout.rect.width,
    height: layout.rect.height,
    overflow: "visible",
    transform: block.rotationDeg
      ? `rotate(${block.rotationDeg}deg)`
      : undefined,
    transformOrigin: "center center",
    pointerEvents: pointerDisabled ? "none" : undefined,
  };
}

// Returns inline overrides only for the editor chrome appearance. When the
// block is excluded the styling comes purely from CSS so the red indicator can
// win regardless of chrome visibility.
function resolveOverlayChromeStyle(
  block: TranslationBlock,
  showChrome: boolean,
  excluded: boolean,
): React.CSSProperties | undefined {
  if (!showChrome || excluded) {
    return undefined;
  }
  const visualStyle = resolveBlockVisualStyle(block.type);
  return {
    borderColor: visualStyle.borderColor,
    backgroundColor: hexToRgba(visualStyle.backgroundColor, block.opacity),
  };
}

function resolveOverlayTextWrapStyle(
  block: TranslationBlock,
  layout: ReturnType<typeof resolveBlockTextLayout>,
): React.CSSProperties {
  return {
    color: block.textColor,
    fontFamily: resolveBlockFontFamily(block.fontFamily),
    fontSize: `${layout.fontSizePx}px`,
    lineHeight: block.lineHeight,
    letterSpacing: block.letterSpacing ? `${block.letterSpacing}em` : undefined,
    textAlign: block.textAlign,
  };
}

function resolveOverlayTextContentStyle(
  block: TranslationBlock,
  layout: ReturnType<typeof resolveBlockTextLayout>,
  renderDirection: ReturnType<typeof normalizeRenderDirection>,
): React.CSSProperties {
  return {
    boxSizing: "border-box",
    writingMode:
      renderDirection === "vertical" ? "vertical-rl" : "horizontal-tb",
    textOrientation: renderDirection === "vertical" ? "upright" : undefined,
    width:
      renderDirection === "vertical"
        ? "max-content"
        : `${layout.fitInnerWidth}px`,
    height:
      renderDirection === "vertical" ? `${layout.fitInnerHeight}px` : undefined,
    maxWidth: "100%",
    maxHeight: "100%",
    overflow: "visible",
    fontWeight: block.bold ? 800 : 400,
    fontStyle: block.italic ? "italic" : "normal",
    fontSynthesis: "weight style",
    textShadow: resolveBlockTextOutlineShadow(block, layout.fontSizePx),
  };
}

function resolveBlockTextOutlineShadow(
  block: TranslationBlock,
  fontSizePx: number,
): string {
  const outlineScale = block.outlineWidthScale ?? 1;
  return outlineScale <= 0
    ? "none"
    : resolveTextOutlineShadow(
        fontSizePx,
        resolveCssColor(block.outlineColor, "#ffffff"),
        outlineScale,
      );
}

function resolveOverlayBlockClassName(
  blockType: TranslationBlock["type"],
  selected: boolean,
  multiSelected: boolean,
  excluded: boolean,
  showChrome: boolean,
): string {
  return [
    "overlay-block",
    `block-${blockType}`,
    selected ? "selected" : "",
    multiSelected ? "multi-selected" : "",
    excluded ? "excluded" : "",
    showChrome ? "" : "chrome-hidden",
  ]
    .filter(Boolean)
    .join(" ");
}

function resolveExcludeToggleTitle(excluded: boolean | undefined): string {
  return excluded ? "인페인팅에 다시 포함" : "인페인팅에서 제외";
}

function stopOverlayControlEvent(
  event: React.MouseEvent | React.PointerEvent,
): void {
  event.preventDefault();
  event.stopPropagation();
}

function resolveTextOutlineShadow(
  fontSizePx: number,
  color: string,
  scale = 1,
): string {
  const radius = resolveTextOutlinePx(fontSizePx) * scale;
  const halfRadius = Math.round(radius * 0.55 * 10) / 10;
  const offsets = [
    [0, -radius],
    [radius, 0],
    [0, radius],
    [-radius, 0],
    [radius, -radius],
    [radius, radius],
    [-radius, radius],
    [-radius, -radius],
    [halfRadius, -halfRadius],
    [halfRadius, halfRadius],
    [-halfRadius, halfRadius],
    [-halfRadius, -halfRadius],
  ];
  return offsets.map(([x, y]) => `${x}px ${y}px 0 ${color}`).join(", ");
}

function resolveTextOutlinePx(fontSizePx: number): number {
  return Math.round(Math.min(4, Math.max(0.35, fontSizePx * 0.055)) * 10) / 10;
}

function resolveCssColor(value: string | undefined, fallback: string): string {
  const text = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}
