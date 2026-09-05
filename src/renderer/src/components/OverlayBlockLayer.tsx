import React from "react";
import { useFonts } from "../fonts/useFonts";
import { useBlockFontReadiness } from "../hooks/useBlockFontReadiness";
import type { BlockFontCatalog } from "../lib/fonts";
import type { ViewportSize } from "../lib/overlayLayout";
import { resolvePageSourceFontFaceFallbacks } from "../lib/sourceFontSizeMatching";
import { OverlayBlockView } from "./OverlayBlock";
import type { ImageStageProps } from "./imageStageTypes";

type OverlayBlockLayerProps = Pick<
  ImageStageProps,
  | "blockPointerDisabled"
  | "imageDataUrl"
  | "interactionPreviewStore"
  | "onBlockPointerDown"
  | "onWarpTransformCommit"
  | "page"
  | "selectedBlockId"
  | "selectedBlockIds"
  | "showBlockChrome"
  | "showTextBlocks"
  | "stageTool"
  | "stageSize"
  | "textLayoutStageSize"
>;

export function OverlayBlockLayer(
  props: OverlayBlockLayerProps,
): React.JSX.Element | null {
  const { catalog, ready = true } = useFonts();
  return (
    <OverlayBlockLayerView
      {...props}
      fontCatalog={catalog}
      fontCatalogReady={ready}
    />
  );
}

type OverlayBlockLayerViewProps = OverlayBlockLayerProps & {
  fontCatalog: BlockFontCatalog;
  fontCatalogReady: boolean;
};

const OverlayBlockLayerView = React.memo(function OverlayBlockLayerView({
  blockPointerDisabled,
  fontCatalog,
  fontCatalogReady,
  imageDataUrl,
  interactionPreviewStore,
  onBlockPointerDown,
  onWarpTransformCommit,
  page,
  selectedBlockId,
  selectedBlockIds,
  showBlockChrome,
  showTextBlocks,
  stageTool,
  stageSize,
  textLayoutStageSize,
}: OverlayBlockLayerViewProps): React.JSX.Element | null {
  const pageSize = React.useMemo(
    () => ({ width: page.width, height: page.height }),
    [page.height, page.width],
  );
  const stableStageSize = useStableViewportSize(stageSize);
  const stableTextLayoutStageSize = useStableViewportSize(textLayoutStageSize);
  const sourceFontFaceFallbacks = React.useMemo(
    () => resolvePageSourceFontFaceFallbacks(page.blocks, pageSize),
    [page.blocks, pageSize],
  );
  const handleBlockPointerDown = useLatestBlockPointerDown(onBlockPointerDown);
  const fontsReady = useBlockFontReadiness(
    page.blocks,
    fontCatalog,
    fontCatalogReady,
  );
  if (!imageDataUrl || !stableStageSize || !fontsReady) {
    return null;
  }
  const visibleBlocks = showTextBlocks
    ? page.blocks
    : page.blocks.filter((block) => block.inpaintExcluded);
  const multiSelection = selectedBlockIds && selectedBlockIds.length > 1;
  const multiSelectedIds = multiSelection ? new Set(selectedBlockIds) : null;
  return (
    <>
      {visibleBlocks.map((block) => (
        <OverlayBlockItem
          key={block.id}
          block={block}
          fontCatalog={fontCatalog}
          pageSize={pageSize}
          stageSize={stableStageSize}
          selected={block.id === selectedBlockId}
          multiSelected={multiSelectedIds?.has(block.id) ?? false}
          showChrome={showBlockChrome}
          shapeEditMode={stageTool === "bubble" && block.id === selectedBlockId}
          sourceFontFaceFallbackPx={sourceFontFaceFallbacks.get(block.id)}
          textLayoutStageSize={stableTextLayoutStageSize}
          pointerDisabled={!showTextBlocks || (blockPointerDisabled ?? false)}
          textVisible={showTextBlocks}
          interactionPreviewStore={interactionPreviewStore}
          transformMode={
            block.id === selectedBlockId &&
            (stageTool === "select" ||
              stageTool === "perspective" ||
              stageTool === "curve" ||
              stageTool === "warp")
              ? stageTool
              : undefined
          }
          onBlockPointerDown={handleBlockPointerDown}
          onWarpTransformCommit={onWarpTransformCommit}
        />
      ))}
    </>
  );
});

type OverlayBlockItemProps = Omit<
  React.ComponentProps<typeof OverlayBlockView>,
  | "onPointerDown"
  | "onResizePointerDown"
  | "onTransformPointerDown"
  | "onWarpTransformCommit"
> & {
  onBlockPointerDown: ImageStageProps["onBlockPointerDown"];
  onWarpTransformCommit?: ImageStageProps["onWarpTransformCommit"];
};

const OverlayBlockItem = React.memo(function OverlayBlockItem({
  block,
  onBlockPointerDown,
  onWarpTransformCommit,
  ...props
}: OverlayBlockItemProps): React.JSX.Element {
  const onPointerDown = React.useCallback(
    (event: React.PointerEvent) => onBlockPointerDown(event, block, "move"),
    [block, onBlockPointerDown],
  );
  const onResizePointerDown = React.useCallback(
    (event: React.PointerEvent) => onBlockPointerDown(event, block, "resize"),
    [block, onBlockPointerDown],
  );
  const onTransformPointerDown = React.useCallback(
    (
      event: React.PointerEvent,
      mode: Parameters<ImageStageProps["onBlockPointerDown"]>[2],
    ) => onBlockPointerDown(event, block, mode),
    [block, onBlockPointerDown],
  );
  return (
    <OverlayBlockView
      {...props}
      block={block}
      onPointerDown={onPointerDown}
      onResizePointerDown={onResizePointerDown}
      onTransformPointerDown={onTransformPointerDown}
      onWarpTransformCommit={
        onWarpTransformCommit
          ? (transform) => onWarpTransformCommit(block.id, transform)
          : undefined
      }
    />
  );
});

function useLatestBlockPointerDown(
  onBlockPointerDown: ImageStageProps["onBlockPointerDown"],
): ImageStageProps["onBlockPointerDown"] {
  const handlerRef = React.useRef(onBlockPointerDown);
  React.useLayoutEffect(() => {
    handlerRef.current = onBlockPointerDown;
  }, [onBlockPointerDown]);
  return React.useCallback(
    (event, block, mode) => handlerRef.current(event, block, mode),
    [],
  );
}

function useStableViewportSize(size: ViewportSize | null): ViewportSize | null {
  const width = size?.width ?? null;
  const height = size?.height ?? null;
  return React.useMemo(
    () => (width !== null && height !== null ? { width, height } : null),
    [height, width],
  );
}
