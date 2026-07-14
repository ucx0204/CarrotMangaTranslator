import React from "react";
import { IconEraserOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import { resolveBlockVisualStyle } from "../../../shared/blockVisuals";
import {
  normalizeRenderDirection,
  resolveFontWidthScale,
} from "../../../shared/geometry";
import { parseRichText } from "../../../shared/richTextMarkup";
import { resolveBlockFontFamily } from "../lib/fonts";
import {
  hexToRgba,
  resolveBlockTextLayout,
  type ViewportSize,
} from "../lib/overlayLayout";
import type { BlockTextLine } from "../lib/overlayTextWrapping";

type OverlayBlockProps = {
  block: TranslationBlock;
  pageSize: ViewportSize;
  stageSize: ViewportSize;
  selected: boolean;
  multiSelected?: boolean;
  showChrome: boolean;
  textLayoutStageSize: ViewportSize | null;
  textVisible?: boolean;
  pointerDisabled?: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onResizePointerDown: (event: React.PointerEvent) => void;
};

export function OverlayBlock({
  block,
  pageSize,
  stageSize,
  selected,
  multiSelected = false,
  showChrome,
  textLayoutStageSize,
  textVisible = true,
  pointerDisabled = false,
  onPointerDown,
  onResizePointerDown,
}: OverlayBlockProps): React.JSX.Element | null {
  const displayText = block.translatedText || block.sourceText || "...";
  const layout = resolveBlockTextLayout(
    block,
    displayText,
    pageSize,
    stageSize,
    { textLayoutStageSize: textLayoutStageSize ?? undefined },
  );
  const renderDirection = normalizeRenderDirection(
    block.renderDirection,
    "horizontal",
  );
  const excluded = Boolean(block.inpaintExcluded);

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
      onPointerDown={resolvePointerHandler(pointerDisabled, onPointerDown)}
    >
      {shouldShowOverlayChrome(textVisible, showChrome, excluded) ? (
        <div
          className="overlay-block-chrome"
          style={resolveOverlayChromeStyle(block, showChrome, excluded)}
        />
      ) : null}
      {textVisible ? (
        <OverlayText
          block={block}
          displayText={displayText}
          layout={layout}
          renderDirection={renderDirection}
        />
      ) : null}
      <OverlayExcludeControl excluded={excluded} />
      {textVisible ? (
        <OverlayResizeHandle
          onResizePointerDown={onResizePointerDown}
          pointerDisabled={pointerDisabled}
          selected={selected}
        />
      ) : null}
    </div>
  );
}

function resolvePointerHandler(
  pointerDisabled: boolean,
  handler: (event: React.PointerEvent) => void,
): ((event: React.PointerEvent) => void) | undefined {
  return pointerDisabled ? undefined : handler;
}

function shouldShowOverlayChrome(
  textVisible: boolean,
  showChrome: boolean,
  excluded: boolean,
): boolean {
  return textVisible && (showChrome || excluded);
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
  const { runs } = parseRichText(
    displayText,
    Boolean(block.bold),
    Boolean(block.italic),
  );
  return (
    <div
      className="overlay-text"
      style={resolveOverlayTextWrapStyle(block, layout)}
    >
      <span
        className="overlay-text-content"
        style={resolveOverlayTextContentStyle(block, layout, renderDirection)}
      >
        {layout.lines
          ? renderFixedHorizontalLines(layout.lines)
          : runs.map((run, index) => renderTextRun(run, index))}
      </span>
    </div>
  );
}

function renderFixedHorizontalLines(lines: BlockTextLine[]): React.ReactNode {
  return lines.map((line, lineIndex) => (
    <span
      className="overlay-text-line"
      key={lineIndex}
      style={{ display: "block", whiteSpace: "pre" }}
    >
      {line.runs.length > 0
        ? line.runs.map((run, runIndex) => renderTextRun(run, runIndex))
        : "\u00a0"}
    </span>
  ));
}

function renderTextRun(
  run: { text: string; bold: boolean; italic: boolean },
  key: React.Key,
): React.JSX.Element {
  return (
    <span
      key={key}
      style={{
        fontWeight: run.bold ? 800 : 400,
        fontStyle: run.italic ? "italic" : "normal",
      }}
    >
      {run.text}
    </span>
  );
}

function OverlayExcludeControl({
  excluded,
}: {
  excluded: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  return excluded ? (
    <span
      className="overlay-excluded-badge"
      role="img"
      aria-label={t("overlay.excludedFromInpainting")}
    >
      <IconEraserOff size={14} stroke={2.4} aria-hidden="true" />
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
  const { t } = useTranslation("components");
  return selected && !pointerDisabled ? (
    <button
      className="resize-handle"
      onPointerDown={onResizePointerDown}
      aria-label={t("overlay.resize")}
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
    bottom: "auto",
    color: block.textColor,
    fontFamily: resolveBlockFontFamily(block.fontFamily),
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

function normalizeTextOpacity(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value as number));
}

function resolveOverlayTextContentStyle(
  block: TranslationBlock,
  layout: ReturnType<typeof resolveBlockTextLayout>,
  renderDirection: ReturnType<typeof normalizeRenderDirection>,
): React.CSSProperties {
  const scaleX = resolveFontWidthScale(block.fontWidthScale);
  return {
    boxSizing: "border-box",
    writingMode:
      renderDirection === "vertical" ? "vertical-rl" : "horizontal-tb",
    textOrientation: renderDirection === "vertical" ? "upright" : undefined,
    width:
      renderDirection === "vertical"
        ? "max-content"
        : `${layout.textContentWidth}px`,
    height:
      renderDirection === "vertical" ? `${layout.fitInnerHeight}px` : undefined,
    maxWidth: "100%",
    maxHeight: "100%",
    overflow: "visible",
    overflowWrap: layout.lines ? "normal" : undefined,
    wordBreak: layout.lines ? "normal" : undefined,
    whiteSpace: layout.lines ? "normal" : undefined,
    fontWeight: block.bold ? 800 : 400,
    fontStyle: block.italic ? "italic" : "normal",
    fontSynthesis: "weight style",
    textShadow: resolveBlockTextOutlineShadow(block, layout.fontSizePx),
    // 장평: squeeze/stretch only the glyphs, never the block box. Anchor the
    // scale to the text alignment so left/right text stays put.
    transform: scaleX === 1 ? undefined : `scaleX(${scaleX})`,
    transformOrigin: resolveFontWidthOrigin(renderDirection, block.textAlign),
  };
}

function resolveFontWidthOrigin(
  renderDirection: ReturnType<typeof normalizeRenderDirection>,
  textAlign: TranslationBlock["textAlign"],
): string {
  if (renderDirection === "vertical") {
    return "center center";
  }
  if (textAlign === "left") {
    return "left center";
  }
  if (textAlign === "right") {
    return "right center";
  }
  return "center center";
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
