import type React from "react";
import {
  matrix3dToCss,
  normalizePerspectiveTransform,
  rectToQuadMatrix3d,
} from "../../../shared/blockTransforms";
import type { TranslationBlock } from "../../../shared/textTypes";
import { resolveBlockVisualStyle } from "../../../shared/blockVisuals";
import { normalizeRenderDirection } from "../lib/blockFormatGeometry";
import {
  hexToRgba,
  resolveBlockTextLayout,
  type BlockTextLayout,
  type ViewportSize,
} from "../lib/overlayLayout";
import type { BlockTransformMode } from "./OverlayTransformControls";

export type OverlayBlockRenderModel = {
  contentStyle: React.CSSProperties | undefined;
  curveRenderable: boolean;
  displayText: string;
  excluded: boolean;
  layout: BlockTextLayout;
  outerClassName: string;
  outerStyle: React.CSSProperties;
  renderDirection: ReturnType<typeof normalizeRenderDirection>;
  showChromeLayer: boolean;
  chromeStyle: React.CSSProperties | undefined;
};

export function resolveOverlayBlockRenderModel({
  block,
  excluded,
  multiSelected,
  pageSize,
  pointerDisabled,
  selected,
  showChrome,
  stageSize,
  textLayoutStageSize,
  textVisible,
  transformMode,
}: {
  block: TranslationBlock;
  excluded: boolean;
  multiSelected: boolean;
  pageSize: ViewportSize;
  pointerDisabled: boolean;
  selected: boolean;
  showChrome: boolean;
  stageSize: ViewportSize;
  textLayoutStageSize: ViewportSize | null;
  textVisible: boolean;
  transformMode?: BlockTransformMode;
}): OverlayBlockRenderModel {
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
  return {
    contentStyle: resolvePerspectiveContentStyle(block, layout),
    curveRenderable: shouldRenderCurveText(block, displayText, renderDirection),
    displayText,
    excluded,
    layout,
    outerClassName: resolveOverlayBlockClassName(
      block.type,
      selected,
      multiSelected,
      excluded,
      showChrome,
      transformMode,
    ),
    outerStyle: resolveOverlayBlockStyle(block, layout, pointerDisabled),
    renderDirection,
    showChromeLayer: textVisible && (showChrome || excluded),
    chromeStyle: resolveOverlayChromeStyle(block, showChrome, excluded),
  };
}

function shouldRenderCurveText(
  block: TranslationBlock,
  displayText: string,
  renderDirection = normalizeRenderDirection(
    block.renderDirection,
    "horizontal",
  ),
): boolean {
  return Boolean(
    block.curveLayout &&
    renderDirection === "horizontal" &&
    !/[\r\n]/.test(displayText),
  );
}

function resolveOverlayBlockStyle(
  block: TranslationBlock,
  layout: BlockTextLayout,
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

function resolvePerspectiveContentStyle(
  block: TranslationBlock,
  layout: BlockTextLayout,
): React.CSSProperties | undefined {
  if (!block.perspectiveTransform) return undefined;
  const transform = normalizePerspectiveTransform(block.perspectiveTransform);
  return {
    transform: matrix3dToCss(
      rectToQuadMatrix3d(
        layout.rect.width,
        layout.rect.height,
        transform.corners,
      ),
    ),
  };
}

function resolveOverlayChromeStyle(
  block: TranslationBlock,
  showChrome: boolean,
  excluded: boolean,
): React.CSSProperties | undefined {
  if (!showChrome || excluded) return undefined;
  const visualStyle = resolveBlockVisualStyle(block.type);
  return {
    borderColor: visualStyle.borderColor,
    backgroundColor: hexToRgba(visualStyle.backgroundColor, block.opacity),
  };
}

function resolveOverlayBlockClassName(
  blockType: TranslationBlock["type"],
  selected: boolean,
  multiSelected: boolean,
  excluded: boolean,
  showChrome: boolean,
  transformMode: BlockTransformMode | undefined,
): string {
  return [
    "overlay-block",
    `block-${blockType}`,
    selected ? "selected" : "",
    multiSelected ? "multi-selected" : "",
    excluded ? "excluded" : "",
    showChrome ? "" : "chrome-hidden",
    transformMode ? `transform-mode-${transformMode}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
