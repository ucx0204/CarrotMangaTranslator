import React from "react";
import {
  CommittedMaskLayer,
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
}: ImageStageProps & {
  retouchModel: RetouchStageModel;
}): React.JSX.Element {
  const stagePointerHandlers = hideEditingOverlays
    ? {}
    : {
        onPointerMove: onStagePointerMove,
        onPointerUp: onStagePointerUp,
        onPointerCancel: onStagePointerUp,
        onPointerLeave: onStagePointerLeave,
        onPointerDown: onStagePointerDown,
      };
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
      )}
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
