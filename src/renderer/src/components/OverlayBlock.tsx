import React from "react";
import type { TranslationBlock } from "../../../shared/types";
import { resolveBlockVisualStyle } from "../../../shared/blockVisuals";
import { resolveBlockFontFamily } from "../lib/fonts";
import { hexToRgba, resolveBlockTextLayout, type ViewportSize } from "../lib/overlayLayout";

type OverlayBlockProps = {
  block: TranslationBlock;
  pageSize: ViewportSize;
  stageSize: ViewportSize;
  selected: boolean;
  showChrome: boolean;
  highlightType: TranslationBlock["type"] | null;
  pointerDisabled?: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onResizePointerDown: (event: React.PointerEvent) => void;
};

export function OverlayBlock({
  block,
  pageSize,
  stageSize,
  selected,
  showChrome,
  highlightType,
  pointerDisabled = false,
  onPointerDown,
  onResizePointerDown
}: OverlayBlockProps): React.JSX.Element | null {
  if (block.renderDirection === "hidden") {
    return null;
  }

  const displayText = block.translatedText || block.sourceText || "...";
  const layout = resolveBlockTextLayout(block, displayText, pageSize, stageSize);
  const textOutlineShadow = resolveTextOutlineShadow(layout.fontSizePx, resolveCssColor(block.outlineColor, "#ffffff"));
  const visualStyle = resolveBlockVisualStyle(block.type);
  const pendingPattern = showChrome && highlightType === "solid" && block.type === "nonsolid";
  const style: React.CSSProperties = {
    left: layout.rect.left,
    top: layout.rect.top,
    width: layout.rect.width,
    height: layout.rect.height,
    boxSizing: "border-box",
    padding: layout.paddingPx,
    overflow: "visible",
    color: block.textColor,
    borderWidth: showChrome ? 2 : 0,
    borderColor: showChrome ? visualStyle.borderColor : "transparent",
    backgroundColor: showChrome ? hexToRgba(visualStyle.backgroundColor, block.opacity) : "transparent",
    fontFamily: resolveBlockFontFamily(block.fontFamily),
    fontSize: `${layout.fontSizePx}px`,
    lineHeight: block.lineHeight,
    textAlign: block.textAlign,
    transform: block.rotationDeg ? `rotate(${block.rotationDeg}deg)` : undefined,
    transformOrigin: "center center",
    pointerEvents: pointerDisabled ? "none" : undefined
  };
  const textWrapStyle: React.CSSProperties = {
    boxSizing: "border-box",
    width: layout.innerWidth,
    maxWidth: "100%",
    height: layout.innerHeight,
    maxHeight: "100%",
    justifyContent: "center",
    overflow: "visible"
  };
  const contentStyle: React.CSSProperties = {
    boxSizing: "border-box",
    writingMode: block.renderDirection === "vertical" ? "vertical-rl" : "horizontal-tb",
    textOrientation: block.renderDirection === "vertical" ? "upright" : undefined,
    width: block.renderDirection === "vertical" ? "max-content" : `${layout.fitInnerWidth}px`,
    height: block.renderDirection === "vertical" ? `${layout.fitInnerHeight}px` : undefined,
    maxWidth: "100%",
    maxHeight: "100%",
    overflow: "visible",
    textShadow: textOutlineShadow
  };

  return (
    <div
      className={[
        "overlay-block",
        `block-${block.type}`,
        selected ? "selected" : "",
        showChrome ? "" : "chrome-hidden",
        showChrome && highlightType && block.type === highlightType ? "highlight-target" : "",
        showChrome && highlightType && block.type !== highlightType ? "highlight-dimmed" : "",
        pendingPattern ? "pattern-pending" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      onPointerDown={pointerDisabled ? undefined : onPointerDown}
    >
      <div className="overlay-text" style={textWrapStyle}>
        <span className="overlay-text-content" style={contentStyle}>
          {displayText}
        </span>
      </div>
      {selected && !pointerDisabled ? <button className="resize-handle" onPointerDown={onResizePointerDown} aria-label="Resize" /> : null}
      {pendingPattern ? (
        <div className="pattern-pending-marker" aria-hidden="true">
          <span>다음 단계에서 처리</span>
        </div>
      ) : null}
    </div>
  );
}

function resolveTextOutlineShadow(fontSizePx: number, color: string): string {
  const radius = resolveTextOutlinePx(fontSizePx);
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
    [-halfRadius, -halfRadius]
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
