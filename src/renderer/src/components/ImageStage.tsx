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

export type { ImageStageProps } from "./imageStageTypes";

export function ImageStage({
  blockPointerDisabled = false,
  imageDataUrl,
  imageRef,
  interactionPreviewStore,
  maskStrokes = [],
  onBlockPointerDown,
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
      imageDataUrl={imageDataUrl}
      imageRef={imageRef}
      interactionPreviewStore={interactionPreviewStore}
      onBlockPointerDown={onBlockPointerDown}
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
  imageDataUrl,
  imageRef,
  interactionPreviewStore,
  onBlockPointerDown,
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
  return (
    <div className="stage-wrap">
      <div
        ref={stageRef}
        className={resolveStageClassName({
          blockPointerDisabled,
          regionSelectionActive,
          retouchCursor,
          stageTool,
        })}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
        onPointerLeave={onStagePointerLeave}
        onPointerDown={onStagePointerDown}
      >
        <ImageStageLayerSet
          blockPointerDisabled={blockPointerDisabled}
          imageDataUrl={imageDataUrl}
          imageRef={imageRef}
          interactionPreviewStore={interactionPreviewStore}
          onBlockPointerDown={onBlockPointerDown}
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

function ImageStageLayerSet({
  blockPointerDisabled = false,
  imageDataUrl,
  imageRef,
  interactionPreviewStore,
  onBlockPointerDown,
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
}: Omit<
  ImageStageProps,
  | "onStagePointerDown"
  | "onStagePointerLeave"
  | "onStagePointerMove"
  | "onStagePointerUp"
  | "stageRef"
> & {
  retouchModel: RetouchStageModel;
}): React.JSX.Element {
  return (
    <>
      <StageImage imageDataUrl={imageDataUrl} imageRef={imageRef} page={page} />
      <OverlayBlockLayer
        blockPointerDisabled={blockPointerDisabled}
        imageDataUrl={imageDataUrl}
        interactionPreviewStore={interactionPreviewStore}
        onBlockPointerDown={onBlockPointerDown}
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
      />
      <StageMarqueeLayers
        imageDataUrl={imageDataUrl}
        interactionPreviewStore={interactionPreviewStore}
        regionSelectionActive={regionSelectionActive}
        regionSelectionRect={regionSelectionRect}
        stageSize={stageSize}
      />
      <StageDragHud interactionPreviewStore={interactionPreviewStore} />
    </>
  );
}
