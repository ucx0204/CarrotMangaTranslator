import React from "react";
import {
  CommittedMaskLayer,
  OverlayBlockLayer,
  RegionSelectionLayer,
  RetouchCursorLayer,
  RetouchPreviewLayer,
  StageDragHud,
  StageImage,
} from "./imageStageLayers";
import {
  resolveRetouchStageModel,
  resolveStageClassName,
} from "./imageStageModel";
import type { ImageStageProps, RetouchStageModel } from "./imageStageTypes";

export type { ImageStageProps } from "./imageStageTypes";

export function ImageStage({
  blockPointerDisabled = false,
  dragHud = null,
  imageDataUrl,
  imageRef,
  inpaintingMode = false,
  maskStrokes = [],
  onBlockPointerDown,
  onStagePointerDown,
  onStagePointerLeave,
  onStagePointerMove,
  onStagePointerUp,
  onToggleBlockExcluded,
  page,
  regionSelectionActive,
  regionSelectionRect,
  retouchCursor = null,
  retouchPreview = null,
  selectedBlockId,
  selectedBlockIds,
  showBlockChrome,
  showTextBlocks,
  stageRef,
  stageSize,
}: ImageStageProps): React.JSX.Element {
  const clipId = React.useId();
  const retouchModel = resolveRetouchStageModel({
    maskStrokes,
    page,
    retouchCursor,
    retouchPreview,
    stageSize,
  });

  return (
    <ImageStageFrame
      blockPointerDisabled={blockPointerDisabled}
      clipId={clipId}
      dragHud={dragHud}
      imageDataUrl={imageDataUrl}
      imageRef={imageRef}
      inpaintingMode={inpaintingMode}
      onBlockPointerDown={onBlockPointerDown}
      onStagePointerDown={onStagePointerDown}
      onStagePointerLeave={onStagePointerLeave}
      onStagePointerMove={onStagePointerMove}
      onStagePointerUp={onStagePointerUp}
      onToggleBlockExcluded={onToggleBlockExcluded}
      page={page}
      regionSelectionActive={regionSelectionActive}
      regionSelectionRect={regionSelectionRect}
      retouchCursor={retouchCursor}
      retouchModel={retouchModel}
      retouchPreview={retouchPreview}
      selectedBlockId={selectedBlockId}
      selectedBlockIds={selectedBlockIds}
      showBlockChrome={showBlockChrome}
      showTextBlocks={showTextBlocks}
      stageRef={stageRef}
      stageSize={stageSize}
    />
  );
}

function ImageStageFrame({
  blockPointerDisabled = false,
  clipId,
  dragHud = null,
  imageDataUrl,
  imageRef,
  inpaintingMode = false,
  onBlockPointerDown,
  onStagePointerDown,
  onStagePointerLeave,
  onStagePointerMove,
  onStagePointerUp,
  onToggleBlockExcluded,
  page,
  regionSelectionActive,
  regionSelectionRect,
  retouchCursor = null,
  retouchModel,
  retouchPreview = null,
  selectedBlockId,
  selectedBlockIds,
  showBlockChrome,
  showTextBlocks,
  stageRef,
  stageSize,
}: ImageStageProps & {
  clipId: string;
  retouchModel: RetouchStageModel;
}): React.JSX.Element {
  return (
    <div className="stage-wrap">
      <div
        ref={stageRef}
        className={resolveStageClassName({
          blockPointerDisabled,
          cursorVisible: retouchModel.cursorVisible,
          regionSelectionActive,
          retouchCursor,
        })}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
        onPointerLeave={onStagePointerLeave}
        onPointerDown={onStagePointerDown}
      >
        <ImageStageLayerSet
          blockPointerDisabled={blockPointerDisabled}
          clipId={clipId}
          dragHud={dragHud}
          imageDataUrl={imageDataUrl}
          imageRef={imageRef}
          inpaintingMode={inpaintingMode}
          onBlockPointerDown={onBlockPointerDown}
          onToggleBlockExcluded={onToggleBlockExcluded}
          page={page}
          regionSelectionActive={regionSelectionActive}
          regionSelectionRect={regionSelectionRect}
          retouchCursor={retouchCursor}
          retouchModel={retouchModel}
          retouchPreview={retouchPreview}
          selectedBlockId={selectedBlockId}
          selectedBlockIds={selectedBlockIds}
          showBlockChrome={showBlockChrome}
          showTextBlocks={showTextBlocks}
          stageSize={stageSize}
        />
      </div>
    </div>
  );
}

function ImageStageLayerSet({
  blockPointerDisabled = false,
  clipId,
  dragHud = null,
  imageDataUrl,
  imageRef,
  inpaintingMode = false,
  onBlockPointerDown,
  onToggleBlockExcluded,
  page,
  regionSelectionActive,
  regionSelectionRect,
  retouchCursor = null,
  retouchModel,
  retouchPreview = null,
  selectedBlockId,
  selectedBlockIds,
  showBlockChrome,
  showTextBlocks,
  stageSize,
}: Omit<
  ImageStageProps,
  | "onStagePointerDown"
  | "onStagePointerLeave"
  | "onStagePointerMove"
  | "onStagePointerUp"
  | "stageRef"
> & {
  clipId: string;
  retouchModel: RetouchStageModel;
}): React.JSX.Element {
  return (
    <>
      <StageImage imageDataUrl={imageDataUrl} imageRef={imageRef} page={page} />
      <OverlayBlockLayer
        blockPointerDisabled={blockPointerDisabled}
        imageDataUrl={imageDataUrl}
        inpaintingMode={inpaintingMode}
        onBlockPointerDown={onBlockPointerDown}
        onToggleBlockExcluded={onToggleBlockExcluded}
        page={page}
        selectedBlockId={selectedBlockId}
        selectedBlockIds={selectedBlockIds}
        showBlockChrome={showBlockChrome}
        showTextBlocks={showTextBlocks}
        stageSize={stageSize}
      />
      <CommittedMaskLayer
        imageDataUrl={imageDataUrl}
        page={page}
        retouchModel={retouchModel}
        stageSize={stageSize}
      />
      <RetouchPreviewLayer
        clipId={clipId}
        imageDataUrl={imageDataUrl}
        page={page}
        retouchModel={retouchModel}
        retouchPreview={retouchPreview}
        stageSize={stageSize}
      />
      <RetouchCursorLayer
        retouchCursor={retouchCursor}
        retouchModel={retouchModel}
        stageSize={stageSize}
      />
      <RegionSelectionLayer
        imageDataUrl={imageDataUrl}
        regionSelectionActive={regionSelectionActive}
        regionSelectionRect={regionSelectionRect}
        stageSize={stageSize}
      />
      <StageDragHud dragHud={dragHud} />
    </>
  );
}
