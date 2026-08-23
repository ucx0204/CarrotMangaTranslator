import React from "react";
import {
  CommittedMaskLayer,
  OriginalImageBlendLayer,
  RetouchLiveLayer,
  StageImage,
  StageMarqueeLayers,
} from "./imageStageLayers";
import { OverlayBlockLayer } from "./OverlayBlockLayer";
import { StageDragHud } from "./StageDragHud";
import {
  resolveRetouchStageModel,
  resolveStageClassName,
} from "./imageStageModel";
import type { ImageStageProps, RetouchStageModel } from "./imageStageTypes";
import { clearRetouchLiveOverlay } from "../lib/retouchLiveOverlay";
import { BubbleLayoutDraftLayer } from "./BubbleLayoutDraftLayer";

export type { ImageStageProps } from "./imageStageTypes";

export function ImageStage({
  blockPointerDisabled = false,
  hideEditingOverlays = false,
  imageDataUrl,
  imageLoading = false,
  imageRef,
  interactionPreviewStore,
  maskStrokes = [],
  onBlockPointerDown,
  onWarpTransformCommit,
  onStagePointerDown,
  onStagePointerLeave,
  onStagePointerMove,
  onStagePointerUp,
  originalImageDataUrl = "",
  originalImageOpacity = 0,
  page,
  regionSelectionActive,
  regionSelectionRect,
  retouchCursor = null,
  retouchOriginalImageDataUrl = "",
  selectedBlockId,
  selectedBlockIds,
  showBlockChrome,
  showTextBlocks,
  stageRef,
  stageSize,
  stageTool,
  textLayoutStageSize,
}: ImageStageProps): React.JSX.Element {
  const retouchModel = React.useMemo(
    () => resolveRetouchStageModel({ maskStrokes }),
    [maskStrokes],
  );
  React.useEffect(() => {
    const stage = stageRef.current;
    return () => clearRetouchLiveOverlay(stage);
  }, [page.id, retouchCursor?.mode, stageRef]);

  return (
    <ImageStageFrame
      blockPointerDisabled={blockPointerDisabled}
      hideEditingOverlays={hideEditingOverlays}
      imageDataUrl={imageDataUrl}
      imageLoading={imageLoading}
      imageRef={imageRef}
      interactionPreviewStore={interactionPreviewStore}
      onBlockPointerDown={onBlockPointerDown}
      onWarpTransformCommit={onWarpTransformCommit}
      onStagePointerDown={onStagePointerDown}
      onStagePointerLeave={onStagePointerLeave}
      onStagePointerMove={onStagePointerMove}
      onStagePointerUp={onStagePointerUp}
      originalImageDataUrl={originalImageDataUrl}
      originalImageOpacity={originalImageOpacity}
      page={page}
      regionSelectionActive={regionSelectionActive}
      regionSelectionRect={regionSelectionRect}
      retouchCursor={retouchCursor}
      retouchModel={retouchModel}
      retouchOriginalImageDataUrl={retouchOriginalImageDataUrl}
      selectedBlockId={selectedBlockId}
      selectedBlockIds={selectedBlockIds}
      showBlockChrome={showBlockChrome}
      showTextBlocks={showTextBlocks}
      stageRef={stageRef}
      stageSize={stageSize}
      stageTool={stageTool}
      textLayoutStageSize={textLayoutStageSize}
    />
  );
}

type ImageStageFrameProps = ImageStageProps & {
  retouchModel: RetouchStageModel;
};

function ImageStageFrame({
  blockPointerDisabled = false,
  hideEditingOverlays = false,
  imageDataUrl,
  imageLoading = false,
  imageRef,
  interactionPreviewStore,
  onBlockPointerDown,
  onWarpTransformCommit,
  onStagePointerDown,
  onStagePointerLeave,
  onStagePointerMove,
  onStagePointerUp,
  originalImageDataUrl = "",
  originalImageOpacity = 0,
  page,
  regionSelectionActive,
  regionSelectionRect,
  retouchCursor = null,
  retouchModel,
  retouchOriginalImageDataUrl = "",
  selectedBlockId,
  selectedBlockIds,
  showBlockChrome,
  showTextBlocks,
  stageRef,
  stageSize,
  stageTool,
  textLayoutStageSize,
}: ImageStageFrameProps): React.JSX.Element {
  const stagePointerHandlers = hideEditingOverlays
    ? {}
    : createStagePointerHandlers(
        onStagePointerDown,
        onStagePointerMove,
        onStagePointerUp,
        onStagePointerLeave,
      );
  return (
    <div className="stage-wrap">
      <div
        ref={stageRef}
        className={resolveStageClassName({
          blockPointerDisabled,
          regionSelectionActive: !hideEditingOverlays && regionSelectionActive,
          retouchCursor: hideEditingOverlays ? null : retouchCursor,
          stageTool: hideEditingOverlays ? undefined : stageTool,
        })}
        {...stagePointerHandlers}
      >
        <ImageStageLayerSet
          blockPointerDisabled={blockPointerDisabled}
          hideEditingOverlays={hideEditingOverlays}
          imageDataUrl={imageDataUrl}
          imageLoading={imageLoading}
          imageRef={imageRef}
          interactionPreviewStore={interactionPreviewStore}
          onBlockPointerDown={onBlockPointerDown}
          onWarpTransformCommit={onWarpTransformCommit}
          originalImageDataUrl={originalImageDataUrl}
          originalImageOpacity={originalImageOpacity}
          page={page}
          regionSelectionActive={regionSelectionActive}
          regionSelectionRect={regionSelectionRect}
          retouchCursor={retouchCursor}
          retouchModel={retouchModel}
          retouchOriginalImageDataUrl={retouchOriginalImageDataUrl}
          selectedBlockId={selectedBlockId}
          selectedBlockIds={selectedBlockIds}
          showBlockChrome={showBlockChrome}
          showTextBlocks={showTextBlocks}
          stageTool={stageTool}
          stageSize={stageSize}
          textLayoutStageSize={textLayoutStageSize}
        />
      </div>
    </div>
  );
}

function createStagePointerHandlers(
  onPointerDown: ImageStageProps["onStagePointerDown"],
  onPointerMove: ImageStageProps["onStagePointerMove"],
  onPointerUp: ImageStageProps["onStagePointerUp"],
  onPointerLeave: ImageStageProps["onStagePointerLeave"],
) {
  return {
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onPointerLeave,
    onPointerDown,
  };
}

type ImageStageLayerSetProps = Omit<
  ImageStageProps,
  | "onStagePointerDown"
  | "onStagePointerLeave"
  | "onStagePointerMove"
  | "onStagePointerUp"
  | "stageRef"
> & {
  retouchModel: RetouchStageModel;
};

function ImageStageLayerSet({
  blockPointerDisabled = false,
  hideEditingOverlays = false,
  imageDataUrl,
  imageLoading = false,
  imageRef,
  interactionPreviewStore,
  onBlockPointerDown,
  onWarpTransformCommit,
  originalImageDataUrl = "",
  originalImageOpacity = 0,
  page,
  regionSelectionActive,
  regionSelectionRect,
  retouchCursor = null,
  retouchModel,
  retouchOriginalImageDataUrl = "",
  selectedBlockId,
  selectedBlockIds,
  showBlockChrome,
  showTextBlocks,
  stageTool,
  stageSize,
  textLayoutStageSize,
}: ImageStageLayerSetProps): React.JSX.Element {
  return (
    <>
      <StageImage
        imageDataUrl={imageDataUrl}
        imageLoading={imageLoading}
        imageRef={imageRef}
        page={page}
      />
      <OriginalImageBlendLayer
        imageDataUrl={originalImageDataUrl}
        opacity={originalImageOpacity}
      />
      {hideEditingOverlays ? null : (
        <>
          <OverlayBlockLayer
            blockPointerDisabled={blockPointerDisabled}
            imageDataUrl={imageDataUrl}
            interactionPreviewStore={interactionPreviewStore}
            onBlockPointerDown={onBlockPointerDown}
            onWarpTransformCommit={onWarpTransformCommit}
            page={page}
            selectedBlockId={selectedBlockId}
            selectedBlockIds={selectedBlockIds}
            showBlockChrome={showBlockChrome}
            showTextBlocks={showTextBlocks}
            stageTool={stageTool}
            stageSize={stageSize}
            textLayoutStageSize={textLayoutStageSize}
          />
          <ImageStageEditingLayers
            imageDataUrl={imageDataUrl}
            interactionPreviewStore={interactionPreviewStore}
            page={page}
            regionSelectionActive={regionSelectionActive}
            regionSelectionRect={regionSelectionRect}
            retouchCursor={retouchCursor}
            retouchModel={retouchModel}
            retouchOriginalImageDataUrl={retouchOriginalImageDataUrl}
            stageSize={stageSize}
          />
        </>
      )}
    </>
  );
}

type ImageStageEditingLayersProps = Pick<
  ImageStageLayerSetProps,
  | "imageDataUrl"
  | "interactionPreviewStore"
  | "page"
  | "regionSelectionActive"
  | "regionSelectionRect"
  | "retouchCursor"
  | "retouchModel"
  | "retouchOriginalImageDataUrl"
  | "stageSize"
>;

function ImageStageEditingLayers({
  imageDataUrl,
  interactionPreviewStore,
  page,
  regionSelectionActive,
  regionSelectionRect,
  retouchCursor = null,
  retouchModel,
  retouchOriginalImageDataUrl = "",
  stageSize,
}: ImageStageEditingLayersProps): React.JSX.Element {
  return (
    <>
      <CommittedMaskLayer
        imageDataUrl={imageDataUrl}
        page={page}
        retouchModel={retouchModel}
        stageSize={stageSize}
      />
      <RetouchLiveLayer
        retouchCursor={retouchCursor}
        retouchOriginalImageDataUrl={retouchOriginalImageDataUrl}
        stageSize={stageSize}
      />
      <StageMarqueeLayers
        imageDataUrl={imageDataUrl}
        interactionPreviewStore={interactionPreviewStore}
        regionSelectionActive={regionSelectionActive}
        regionSelectionRect={regionSelectionRect}
        stageSize={stageSize}
      />
      <StageBubbleLayoutDraft
        imageDataUrl={imageDataUrl}
        interactionPreviewStore={interactionPreviewStore}
        stageSize={stageSize}
      />
      <StageDragHud interactionPreviewStore={interactionPreviewStore} />
    </>
  );
}

function StageBubbleLayoutDraft({
  imageDataUrl,
  interactionPreviewStore,
  stageSize,
}: Pick<
  ImageStageProps,
  "imageDataUrl" | "interactionPreviewStore" | "stageSize"
>): React.JSX.Element {
  return (
    <BubbleLayoutDraftLayer
      imageDataUrl={imageDataUrl}
      interactionPreviewStore={interactionPreviewStore}
      stageSize={stageSize}
    />
  );
}
