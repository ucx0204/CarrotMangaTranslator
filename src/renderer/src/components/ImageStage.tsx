import React from "react";
import {
  CommittedMaskLayer,
  OverlayBlockLayer,
  RetouchLiveLayer,
  StageDragHud,
  StageImage,
  StageMarqueeLayers,
} from "./imageStageLayers";
import {
  resolveRetouchStageModel,
  resolveStageClassName,
} from "./imageStageModel";
import type { ImageStageProps, RetouchStageModel } from "./imageStageTypes";
import { clearRetouchLiveOverlay } from "../lib/retouchLiveOverlay";

export type { ImageStageProps } from "./imageStageTypes";

export function ImageStage({
  blockCreateRect = null,
  blockPointerDisabled = false,
  dragHud = null,
  imageDataUrl,
  imageRef,
  showInpaintingExclusions = false,
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
      blockCreateRect={blockCreateRect}
      blockPointerDisabled={blockPointerDisabled}
      dragHud={dragHud}
      imageDataUrl={imageDataUrl}
      imageRef={imageRef}
      showInpaintingExclusions={showInpaintingExclusions}
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
  blockCreateRect = null,
  blockPointerDisabled = false,
  dragHud = null,
  imageDataUrl,
  imageRef,
  showInpaintingExclusions = false,
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
          blockCreateRect={blockCreateRect}
          blockPointerDisabled={blockPointerDisabled}
          dragHud={dragHud}
          imageDataUrl={imageDataUrl}
          imageRef={imageRef}
          showInpaintingExclusions={showInpaintingExclusions}
          onBlockPointerDown={onBlockPointerDown}
          onToggleBlockExcluded={onToggleBlockExcluded}
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
          stageSize={stageSize}
          textLayoutStageSize={textLayoutStageSize}
        />
      </div>
    </div>
  );
}

function ImageStageLayerSet({
  blockCreateRect = null,
  blockPointerDisabled = false,
  dragHud = null,
  imageDataUrl,
  imageRef,
  showInpaintingExclusions = false,
  onBlockPointerDown,
  onToggleBlockExcluded,
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
        showInpaintingExclusions={showInpaintingExclusions}
        onBlockPointerDown={onBlockPointerDown}
        onToggleBlockExcluded={onToggleBlockExcluded}
        page={page}
        selectedBlockId={selectedBlockId}
        selectedBlockIds={selectedBlockIds}
        showBlockChrome={showBlockChrome}
        showTextBlocks={showTextBlocks}
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
        blockCreateRect={blockCreateRect}
        imageDataUrl={imageDataUrl}
        regionSelectionActive={regionSelectionActive}
        regionSelectionRect={regionSelectionRect}
        stageSize={stageSize}
      />
      <StageDragHud dragHud={dragHud} />
    </>
  );
}
