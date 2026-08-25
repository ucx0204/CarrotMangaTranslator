import React from "react";
import { IconEraserOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type {
  TranslationBlock,
  WarpTransform,
} from "../../../shared/textTypes";
import type { DragMode } from "../lib/workspaceInteractionTypes";
import { useFonts } from "../fonts/useFonts";
import type { BlockFontCatalog } from "../lib/fonts";
import type { ViewportSize } from "../lib/overlayLayout";
import {
  useBlockInteractionPreview,
  type WorkspaceInteractionPreviewStore,
} from "../lib/workspaceInteractionPreview";
import { ArtworkBlock } from "./PageArtwork";
import { BubbleLayoutGuide } from "./BubbleLayoutGuide";
import {
  resolveOverlayBlockRenderModel,
  type OverlayBlockRenderModel,
} from "./overlayBlockModel";
import {
  OverlayTransformControls,
  type BlockTransformMode,
} from "./OverlayTransformControls";
import { usePreviewAwareBlockLayout } from "./useOverlayBlockLayout";

type OverlayBlockProps = {
  block: TranslationBlock;
  pageSize: ViewportSize;
  stageSize: ViewportSize;
  selected: boolean;
  multiSelected?: boolean;
  showChrome: boolean;
  shapeEditMode?: boolean;
  sourceFontFaceFallbackPx?: number;
  textLayoutStageSize: ViewportSize | null;
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
  textVisible?: boolean;
  pointerDisabled?: boolean;
  transformMode?: BlockTransformMode;
  onPointerDown: (event: React.PointerEvent) => void;
  onResizePointerDown: (event: React.PointerEvent) => void;
  onTransformPointerDown?: (event: React.PointerEvent, mode: DragMode) => void;
  onWarpTransformCommit?: (transform: WarpTransform) => void;
};

export const OverlayBlock = React.memo(function OverlayBlock(
  props: OverlayBlockProps,
): React.JSX.Element {
  const { catalog } = useFonts();
  return <OverlayBlockView {...props} fontCatalog={catalog} />;
});

export const OverlayBlockView = React.memo(function OverlayBlockView(
  props: OverlayBlockProps & {
    fontCatalog: BlockFontCatalog;
  },
): React.JSX.Element {
  const catalog = props.fontCatalog;
  const previewBlock = useBlockInteractionPreview(
    props.interactionPreviewStore,
    props.block.id,
  );
  const block = resolvePreviewBlock(previewBlock, props.block);
  const displayText = resolveDisplayText(block, props.showChrome);
  const layout = usePreviewAwareBlockLayout({
    block,
    canonicalBlock: props.block,
    displayText,
    fontCatalog: catalog,
    pageSize: props.pageSize,
    sourceFontFaceFallbackPx: props.sourceFontFaceFallbackPx,
    stageSize: props.stageSize,
    textLayoutStageSize: props.textLayoutStageSize,
  });
  const selectedMode = resolveSelectedMode(props);
  const flags = resolveOverlayBlockFlags(props);
  const excluded = Boolean(block.inpaintExcluded);
  const model = resolveOverlayBlockRenderModel({
    ...props,
    block,
    excluded,
    fontCatalog: catalog,
    layout,
    multiSelected: flags.multiSelected,
    pointerDisabled: flags.pointerDisabled,
    selected: props.selected && !props.shapeEditMode,
    textVisible: flags.textVisible,
    transformMode: selectedMode,
  });
  return (
    <ArtworkBlock
      afterContent={
        <>
          <OverlayExcludeControl excluded={excluded} />
          <OverlayBlockControls
            block={block}
            model={model}
            mode={selectedMode}
            onPointerDown={resolveTransformPointerDown(props)}
            onWarpTransformCommit={props.onWarpTransformCommit}
            pageSize={props.pageSize}
            pointerDisabled={flags.pointerDisabled}
            selected={props.selected}
            textVisible={flags.textVisible}
          />
        </>
      }
      block={block}
      chrome={
        <>
          {model.showChromeLayer ? (
            <div className="overlay-block-chrome" style={model.chromeStyle} />
          ) : null}
          <BubbleLayoutGuide
            block={block}
            height={model.layout.layoutHeight}
            selected={props.selected}
            width={model.layout.layoutWidth}
          />
        </>
      }
      fontCatalog={catalog}
      model={model}
      onPointerDown={resolveOuterPointerDown(props)}
      warpPreview={previewBlock !== null}
    />
  );
});

function resolvePreviewBlock(
  preview: TranslationBlock | null,
  canonical: TranslationBlock,
): TranslationBlock {
  return preview ?? canonical;
}

function resolveDisplayText(
  block: TranslationBlock,
  showChrome: boolean,
): string {
  return block.translatedText || block.sourceText || (showChrome ? "..." : "");
}

function resolveSelectedMode(
  props: OverlayBlockProps,
): BlockTransformMode | undefined {
  if (props.shapeEditMode) return undefined;
  return props.transformMode ?? (props.selected ? "select" : undefined);
}

function resolveOverlayBlockFlags(props: OverlayBlockProps): {
  multiSelected: boolean;
  pointerDisabled: boolean;
  textVisible: boolean;
} {
  return {
    multiSelected: props.multiSelected ?? false,
    pointerDisabled: props.pointerDisabled ?? false,
    textVisible: props.textVisible ?? true,
  };
}

function resolveOuterPointerDown(
  props: OverlayBlockProps,
): OverlayBlockProps["onPointerDown"] | undefined {
  return props.pointerDisabled ? undefined : props.onPointerDown;
}

function resolveTransformPointerDown(
  props: OverlayBlockProps,
): NonNullable<OverlayBlockProps["onTransformPointerDown"]> {
  return (
    props.onTransformPointerDown ??
    ((event) => props.onResizePointerDown(event))
  );
}

function OverlayBlockControls({
  block,
  model,
  mode,
  onPointerDown,
  onWarpTransformCommit,
  pageSize,
  pointerDisabled,
  selected,
  textVisible,
}: {
  block: TranslationBlock;
  model: OverlayBlockRenderModel;
  mode?: BlockTransformMode;
  onPointerDown: (event: React.PointerEvent, mode: DragMode) => void;
  onWarpTransformCommit?: (transform: WarpTransform) => void;
  pageSize: ViewportSize;
  pointerDisabled: boolean;
  selected: boolean;
  textVisible: boolean;
}): React.JSX.Element | null {
  if (!selected || !textVisible || pointerDisabled || !mode) return null;
  return (
    <OverlayTransformControls
      block={block}
      height={model.layout.rect.height}
      mode={mode}
      onPointerDown={onPointerDown}
      onWarpTransformCommit={onWarpTransformCommit}
      pageSize={pageSize}
      showCurveGuide={model.curveRenderable}
      width={model.layout.rect.width}
    />
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
