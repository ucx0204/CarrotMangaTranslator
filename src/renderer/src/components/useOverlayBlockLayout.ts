import React from "react";
import { parseRichText } from "../../../shared/richTextMarkup";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFontCatalog } from "../lib/fonts";
import {
  resolveBlockRectPx,
  resolveBlockTextLayout,
  type BlockTextLayout,
  type ViewportSize,
} from "../lib/overlayLayout";

type LayoutInput = {
  block: TranslationBlock;
  displayText: string;
  fontCatalog: BlockFontCatalog;
  fontRevision: number;
  pageSize: ViewportSize;
  stageSize: ViewportSize;
  textLayoutStageSize: ViewportSize | null;
};

export function usePreviewAwareBlockLayout({
  block,
  canonicalBlock,
  displayText,
  fontCatalog,
  fontRevision,
  pageSize,
  stageSize,
  textLayoutStageSize,
}: Omit<LayoutInput, "block"> & {
  block: TranslationBlock;
  canonicalBlock: TranslationBlock;
}): BlockTextLayout {
  const canonicalText = resolveDisplayText(canonicalBlock);
  const canonicalLayout = useCanonicalLayout({
    block: canonicalBlock,
    displayText: canonicalText,
    fontCatalog,
    fontRevision,
    pageSize,
    stageSize,
    textLayoutStageSize,
  });
  const placement = usePreviewPlacement({
    block,
    displayText,
    pageSize,
    stageSize,
    textLayoutStageSize,
  });
  const canReuseCanonical = canReuseCanonicalLayout(
    canonicalBlock,
    block,
    canonicalText,
    displayText,
    canonicalLayout,
    placement.layoutRect,
  );
  const previewLayout = usePreviewLayout({
    block,
    canReuseCanonical,
    displayText,
    fontCatalog,
    fontRevision,
    pageSize,
    stageSize,
    textLayoutStageSize,
  });
  return placeBlockLayout(
    previewLayout ?? canonicalLayout,
    placement.visualRect,
  );
}

function useCanonicalLayout({
  block,
  displayText,
  fontCatalog,
  fontRevision,
  pageSize,
  stageSize,
  textLayoutStageSize,
}: LayoutInput): BlockTextLayout {
  const layoutStageSize = textLayoutStageSize ?? stageSize;
  return React.useMemo(
    () =>
      resolveInputLayout({
        block,
        displayText,
        fontCatalog,
        fontRevision,
        pageSize,
        stageSize: layoutStageSize,
        textLayoutStageSize: layoutStageSize,
      }),
    [block, displayText, fontCatalog, fontRevision, layoutStageSize, pageSize],
  );
}

function usePreviewLayout({
  block,
  canReuseCanonical,
  displayText,
  fontCatalog,
  fontRevision,
  pageSize,
  stageSize,
  textLayoutStageSize,
}: LayoutInput & { canReuseCanonical: boolean }): BlockTextLayout | null {
  const layoutStageSize = textLayoutStageSize ?? stageSize;
  return React.useMemo(
    () =>
      canReuseCanonical
        ? null
        : resolveInputLayout({
            block,
            displayText,
            fontCatalog,
            fontRevision,
            pageSize,
            stageSize: layoutStageSize,
            textLayoutStageSize: layoutStageSize,
          }),
    [
      block,
      canReuseCanonical,
      displayText,
      fontCatalog,
      fontRevision,
      layoutStageSize,
      pageSize,
    ],
  );
}

function resolveInputLayout({
  block,
  displayText,
  fontCatalog,
  pageSize,
  stageSize,
  textLayoutStageSize,
  fontRevision,
}: LayoutInput): BlockTextLayout {
  void fontRevision;
  return resolveBlockTextLayout(
    block,
    displayText,
    pageSize,
    stageSize,
    fontCatalog,
    { textLayoutStageSize: textLayoutStageSize ?? undefined },
  );
}

function usePreviewPlacement({
  block,
  displayText,
  pageSize,
  stageSize,
  textLayoutStageSize,
}: Omit<LayoutInput, "fontCatalog" | "fontRevision">): {
  layoutRect: BlockTextLayout["rect"];
  visualRect: BlockTextLayout["rect"];
} {
  const plainText = React.useMemo(
    () =>
      parseRichText(displayText, Boolean(block.bold), Boolean(block.italic))
        .plainText,
    [block.bold, block.italic, displayText],
  );
  return {
    layoutRect: resolveBlockRectPx(
      block,
      pageSize,
      textLayoutStageSize ?? stageSize,
      plainText,
    ),
    visualRect: resolveBlockRectPx(block, pageSize, stageSize, plainText),
  };
}

function canReuseCanonicalLayout(
  canonical: TranslationBlock,
  candidate: TranslationBlock,
  canonicalText: string,
  candidateText: string,
  canonicalLayout: BlockTextLayout,
  candidateLayoutRect: BlockTextLayout["rect"],
): boolean {
  const matchingInputs = [
    canonicalText === candidateText,
    canonical.autoFitText === candidate.autoFitText,
    canonical.bold === candidate.bold,
    canonical.fontFamily === candidate.fontFamily,
    canonical.fontSizePx === candidate.fontSizePx,
    canonical.fontWidthScale === candidate.fontWidthScale,
    canonical.italic === candidate.italic,
    canonical.letterSpacing === candidate.letterSpacing,
    canonical.lineHeight === candidate.lineHeight,
    canonical.renderDirection === candidate.renderDirection,
    canonical.wordBreak === candidate.wordBreak,
  ];
  return (
    matchingInputs.every(Boolean) &&
    nearlyEqual(candidateLayoutRect.width, canonicalLayout.layoutWidth) &&
    nearlyEqual(candidateLayoutRect.height, canonicalLayout.layoutHeight)
  );
}

function placeBlockLayout(
  layout: BlockTextLayout,
  rect: BlockTextLayout["rect"],
): BlockTextLayout {
  if (sameRect(layout.rect, rect)) {
    return layout;
  }
  return {
    ...layout,
    rect,
    textScaleX: rect.width / layout.layoutWidth,
    textScaleY: rect.height / layout.layoutHeight,
  };
}

function sameRect(
  left: BlockTextLayout["rect"],
  right: BlockTextLayout["rect"],
): boolean {
  return [
    nearlyEqual(left.left, right.left),
    nearlyEqual(left.top, right.top),
    nearlyEqual(left.width, right.width),
    nearlyEqual(left.height, right.height),
  ].every(Boolean);
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}

function resolveDisplayText(block: TranslationBlock): string {
  return block.translatedText || block.sourceText || "...";
}
