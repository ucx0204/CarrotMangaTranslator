import React from "react";
import { normalizeCurveLayout } from "../../../shared/blockTransforms";
import type { PageArtworkSnapshot } from "../../../shared/pageExportContracts";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFontCatalog } from "../lib/fonts";
import {
  resolveBlockTextLayout,
  type BlockTextLayout,
  type ViewportSize,
} from "../lib/overlayLayout";
import { CurveText } from "./CurveText";
import { OverlayText } from "./OverlayText";
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
};

export const ArtworkBlock = React.memo(function ArtworkBlock({
  afterContent,
  block,
  chrome,
  fontCatalog,
  model,
  onPointerDown,
}: ArtworkBlockProps): React.JSX.Element {
  return (
    <div
      className={model.outerClassName}
      style={model.outerStyle}
      onPointerDown={onPointerDown}
    >
      <div className="overlay-transform-content" style={model.contentStyle}>
        {chrome}
        <ArtworkBlockText
          block={block}
          fontCatalog={fontCatalog}
          model={model}
        />
      </div>
      {afterContent}
    </div>
  );
});

function ArtworkBlockText({
  block,
  fontCatalog,
  model,
}: {
  block: TranslationBlock;
  fontCatalog: BlockFontCatalog;
  model: OverlayBlockRenderModel;
}): React.JSX.Element | null {
  if (!model.textVisible) return null;
  if (model.curveRenderable && block.curveLayout) {
    return (
      <CurveText
        block={block}
        curveLayout={normalizeCurveLayout(block.curveLayout)}
        displayText={model.displayText}
        fontCatalog={fontCatalog}
        layout={model.layout}
      />
    );
  }
  return (
    <OverlayText
      block={block}
      displayText={model.displayText}
      fontCatalog={fontCatalog}
      layout={model.layout}
      renderDirection={model.renderDirection}
    />
  );
}

export function PageArtwork({
  fontCatalog,
  imageSrc,
  page,
  showImage = true,
  visualSize,
}: {
  fontCatalog: BlockFontCatalog;
  imageSrc: string;
  page: PageArtworkSnapshot;
  showImage?: boolean;
  visualSize: ViewportSize;
}): React.JSX.Element {
  const pageSize = React.useMemo(
    () => ({ width: page.width, height: page.height }),
    [page.height, page.width],
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
  visualSize,
}: {
  block: TranslationBlock;
  fontCatalog: BlockFontCatalog;
  pageSize: ViewportSize;
  visualSize: ViewportSize;
}): React.JSX.Element {
  const displayText = block.translatedText || block.sourceText;
  const layout = useArtworkBlockLayout({
    block,
    displayText,
    fontCatalog,
    pageSize,
    visualSize,
  });
  const model = resolveOverlayBlockRenderModel({
    block,
    displayText,
    excluded: Boolean(block.inpaintExcluded),
    fontCatalog,
    layout,
    multiSelected: false,
    pageSize,
    pointerDisabled: true,
    selected: false,
    showChrome: false,
    stageSize: visualSize,
    textLayoutStageSize: pageSize,
    textVisible: true,
  });
  return <ArtworkBlock block={block} fontCatalog={fontCatalog} model={model} />;
}

function useArtworkBlockLayout({
  block,
  displayText,
  fontCatalog,
  pageSize,
  visualSize,
}: {
  block: TranslationBlock;
  displayText: string;
  fontCatalog: BlockFontCatalog;
  pageSize: ViewportSize;
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
        { textLayoutStageSize: pageSize },
      ),
    [block, displayText, fontCatalog, pageSize, visualSize],
  );
}
