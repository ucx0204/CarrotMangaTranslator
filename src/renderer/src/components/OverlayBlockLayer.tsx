import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import { useFonts } from "../fonts/useFonts";
import {
  areBlockFontsReadyForKey,
  createBlockFontLoadKey,
  loadBlockFontsForKey,
} from "../lib/blockFontLoading";
import type { BlockFontCatalog } from "../lib/fonts";
import type { ViewportSize } from "../lib/overlayLayout";
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

function useBlockFontReadiness(
  blocks: readonly TranslationBlock[],
  catalog: BlockFontCatalog,
  catalogReady: boolean,
): boolean {
  const loadKey = React.useMemo(
    () => createBlockFontLoadKey(blocks, catalog),
    [blocks, catalog],
  );
  const [settledLoadKey, setSettledLoadKey] = React.useState<string | null>(
    null,
  );
  const fontSetAvailable =
    typeof document !== "undefined" && Boolean(document.fonts);
  const cached =
    catalogReady &&
    fontSetAvailable &&
    areBlockFontsReadyForKey(document, loadKey);
  const ready =
    catalogReady && (!fontSetAvailable || cached || settledLoadKey === loadKey);
  React.useEffect(() => {
    if (!catalogReady || !fontSetAvailable || ready) return;
    if (areBlockFontsReadyForKey(document, loadKey)) {
      setSettledLoadKey(loadKey);
      return;
    }
    let active = true;
    void loadBlockFontsForKey(document, loadKey)
      .then((report) => {
        if (!active) return;
        reportBlockFontLoadIssue(report);
        setSettledLoadKey(loadKey);
      })
      .catch((error: unknown) => {
        if (!active) return;
        console.error("페이지 글꼴을 불러오지 못했습니다.", error);
        // Do not leave the page permanently blank when browser font loading
        // itself fails; render once with the browser's fallback stack.
        setSettledLoadKey(loadKey);
      });
    return () => {
      active = false;
    };
  }, [catalogReady, fontSetAvailable, loadKey, ready]);
  return ready;
}

function reportBlockFontLoadIssue(
  report: Awaited<ReturnType<typeof loadBlockFontsForKey>>,
): void {
  if (report.failures.length === 0 && report.missingFamilies.length === 0) {
    return;
  }
  console.error("일부 페이지 글꼴을 불러오지 못했습니다.", report);
}
