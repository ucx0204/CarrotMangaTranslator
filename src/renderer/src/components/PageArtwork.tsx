import React from "react";
import { normalizeCurveLayout } from "../../../shared/blockTransforms";
import type { PageArtworkSnapshot } from "../../../shared/pageExportContracts";
import type { TranslationBlock } from "../../../shared/textTypes";
import { resolveTextEffectFilter } from "../../../shared/textEffect";
import type { BlockFontCatalog } from "../lib/fonts";
import {
  resolveBlockTextLayout,
  type BlockTextLayout,
  type ViewportSize,
} from "../lib/overlayLayout";
import { resolvePageSourceFontFaceFallbacks } from "../lib/sourceFontSizeMatching";
import { CurveText } from "./CurveText";
import { OverlayText } from "./OverlayText";
import { WarpedTextContent } from "./WarpedTextContent";
import {
  resolveOverlayBlockRenderModel,
  type OverlayBlockRenderModel,
} from "./overlayBlockModel";
import "./overlayTransforms.css";

type ArtworkBlockProps = {
  afterContent?: React.ReactNode;
  block: TranslationBlock;
  chrome?: React.ReactNode;
  fontCatalog: BlockFontCatalog;
  model: OverlayBlockRenderModel;
  onPointerDown?: (event: React.PointerEvent) => void;
  warpPreview?: boolean;
};

export const ArtworkBlock = React.memo(function ArtworkBlock({
  afterContent,
  block,
  chrome,
  fontCatalog,
  model,
  onPointerDown,
  warpPreview = false,
}: ArtworkBlockProps): React.JSX.Element {
  return (
    <div
      className={model.outerClassName}
      style={model.outerStyle}
      onPointerDown={onPointerDown}
    >
      <div className="overlay-transform-content" style={model.contentStyle}>
        {chrome}
        <TextBackgroundLayer block={block} />
        <ArtworkBlockText
          block={block}
          fontCatalog={fontCatalog}
          model={model}
          warpPreview={warpPreview}
        />
      </div>
      {afterContent}
    </div>
  );
});

function TextBackgroundLayer({
  block,
}: {
  block: TranslationBlock;
}): React.JSX.Element | null {
  if (!block.textBackgroundEnabled) return null;
  return (
    <div
      aria-hidden="true"
      className="text-background-layer"
      style={{ backgroundColor: block.textBackgroundColor ?? "#ffffff" }}
    />
  );
}

function ArtworkBlockText({
  block,
  fontCatalog,
  model,
  warpPreview,
}: {
  block: TranslationBlock;
  fontCatalog: BlockFontCatalog;
  model: OverlayBlockRenderModel;
  warpPreview: boolean;
}): React.JSX.Element | null {
  if (!model.textVisible) return null;
  const text =
    model.curveRenderable && block.curveLayout ? (
      <CurveText
        block={block}
        curveLayout={normalizeCurveLayout(block.curveLayout)}
        displayText={model.displayText}
        fontCatalog={fontCatalog}
        layout={model.layout}
      />
    ) : (
      <OverlayText
        block={block}
        displayText={model.displayText}
        fontCatalog={fontCatalog}
        layout={model.layout}
        renderDirection={model.renderDirection}
      />
    );
  return (
    <TextEffectLayer block={block} scale={model.stageScale}>
      <WarpedTextContent
        height={model.layout.rect.height}
        preview={warpPreview}
        transform={block.warpTransform}
        width={model.layout.rect.width}
      >
        {text}
      </WarpedTextContent>
    </TextEffectLayer>
  );
}

function TextEffectLayer({
  block,
  children,
  scale,
}: {
  block: TranslationBlock;
  children: React.ReactNode;
  scale: { x: number; y: number };
}): React.JSX.Element {
  const filter = resolveTextEffectFilter(block.textEffect, scale);
  return filter ? (
    <div className="text-effect-layer" style={{ filter }}>
      {children}
    </div>
  ) : (
    <>{children}</>
  );
}

export function PageArtwork({
  fontCatalog,
  imageSrc,
  page,
  showImage = true,
  showBlockChrome = false,
  visualSize,
}: {
  fontCatalog: BlockFontCatalog;
  imageSrc: string;
  page: PageArtworkSnapshot;
  showImage?: boolean;
  showBlockChrome?: boolean;
  visualSize: ViewportSize;
}): React.JSX.Element {
  const pageSize = React.useMemo(
    () => ({ width: page.width, height: page.height }),
    [page.height, page.width],
  );
  const sourceFontFaceFallbacks = React.useMemo(
    () => resolvePageSourceFontFaceFallbacks(page.blocks, pageSize),
    [page.blocks, pageSize],
  );
  return (
    <div
      className="image-stage page-artwork"
      data-page-artwork=""
      data-transparent-background={showImage ? undefined : ""}
      style={{ height: visualSize.height, width: visualSize.width }}
    >
      {showImage ? (
        <img
          alt={page.name}
          className="page-image"
          draggable={false}
          height={visualSize.height}
          src={imageSrc}
          width={visualSize.width}
        />
      ) : null}
      {page.blocks.map((block) => (
        <PageArtworkBlock
          block={block}
          fontCatalog={fontCatalog}
          key={block.id}
          pageSize={pageSize}
          showBlockChrome={showBlockChrome}
          sourceFontFaceFallbackPx={sourceFontFaceFallbacks.get(block.id)}
          visualSize={visualSize}
        />
      ))}
    </div>
  );
}

function PageArtworkBlock({
  block,
  fontCatalog,
  pageSize,
  showBlockChrome,
  sourceFontFaceFallbackPx,
  visualSize,
}: {
  block: TranslationBlock;
  fontCatalog: BlockFontCatalog;
  pageSize: ViewportSize;
  showBlockChrome: boolean;
  sourceFontFaceFallbackPx?: number;
  visualSize: ViewportSize;
}): React.JSX.Element {
  const displayText = block.translatedText || block.sourceText;
  const layout = useArtworkBlockLayout({
    block,
    displayText,
    fontCatalog,
    pageSize,
    sourceFontFaceFallbackPx,
    visualSize,
  });
  const model = resolveOverlayBlockRenderModel({
    block,
    displayText,
    excluded: showBlockChrome ? false : Boolean(block.inpaintExcluded),
    fontCatalog,
    layout,
    multiSelected: false,
    pageSize,
    pointerDisabled: true,
    selected: false,
    showChrome: showBlockChrome,
    stageSize: visualSize,
    textLayoutStageSize: pageSize,
    textVisible: true,
  });
  return (
    <ArtworkBlock
      block={block}
      chrome={
        showBlockChrome && model.showChromeLayer ? (
          <div className="overlay-block-chrome" style={model.chromeStyle} />
        ) : null
      }
      fontCatalog={fontCatalog}
      model={model}
    />
  );
}

function useArtworkBlockLayout({
  block,
  displayText,
  fontCatalog,
  pageSize,
  sourceFontFaceFallbackPx,
  visualSize,
}: {
  block: TranslationBlock;
  displayText: string;
  fontCatalog: BlockFontCatalog;
  pageSize: ViewportSize;
  sourceFontFaceFallbackPx?: number;
  visualSize: ViewportSize;
}): BlockTextLayout {
  return React.useMemo(
    () =>
      resolveBlockTextLayout(
        block,
        displayText,
        pageSize,
        visualSize,
        fontCatalog,
        { sourceFontFaceFallbackPx, textLayoutStageSize: pageSize },
      ),
    [
      block,
      displayText,
      fontCatalog,
      pageSize,
      sourceFontFaceFallbackPx,
      visualSize,
    ],
  );
}
