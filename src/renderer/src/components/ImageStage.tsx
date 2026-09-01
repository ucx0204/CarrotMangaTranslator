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
import { SoundEffectReviewLayer } from "./SoundEffectReviewLayer";

export type { ImageStageProps } from "./imageStageTypes";

export function ImageStage(props: ImageStageProps): React.JSX.Element {
  const retouchModel = React.useMemo(
    () => resolveRetouchStageModel({ maskStrokes: props.maskStrokes ?? [] }),
    [props.maskStrokes],
  );
  React.useEffect(() => {
    const stage = props.stageRef.current;
    return () => clearRetouchLiveOverlay(stage);
  }, [props.page.id, props.retouchCursor?.mode, props.stageRef]);

  return <ImageStageFrame {...props} retouchModel={retouchModel} />;
}

type ImageStageFrameProps = ImageStageProps & {
  retouchModel: RetouchStageModel;
};

function ImageStageFrame(props: ImageStageFrameProps): React.JSX.Element {
  const {
    hideEditingOverlays = false,
    onStagePointerDown,
    onStagePointerLeave,
    onStagePointerMove,
    onStagePointerUp,
    stageRef,
    ...layerProps
  } = props;
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
          blockPointerDisabled: props.blockPointerDisabled ?? false,
          regionSelectionActive:
            !hideEditingOverlays && props.regionSelectionActive,
          retouchCursor: hideEditingOverlays
            ? null
            : (props.retouchCursor ?? null),
          stageTool: hideEditingOverlays ? undefined : props.stageTool,
        })}
        {...stagePointerHandlers}
      >
        <ImageStageLayerSet
          {...layerProps}
          hideEditingOverlays={hideEditingOverlays}
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

// Keeping the ordered layer stack together makes its z-order reviewable.
// eslint-disable-next-line max-lines-per-function
function ImageStageLayerSet({
  blockPointerDisabled = false,
  hideEditingOverlays = false,
  imageDataUrl,
  imageLoading = false,
  imageRef,
  interactionPreviewStore,
  onBlockPointerDown,
  onWarpTransformCommit,
  onDismissSoundEffectReviewRegion,
  onExitSoundEffectReview,
  onOpenSoundEffectTranslation,
  onSelectSoundEffectReviewRegion,
  onTranslateSoundEffectReviewRegion,
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
  selectedSoundEffectReviewRegionId,
  showBlockChrome,
  showSoundEffectReview,
  showTextBlocks,
  stageTool,
  stageSize,
  textLayoutStageSize,
}: ImageStageLayerSetProps): React.JSX.Element {
  return (
    <>
      <BaseImageLayers
        imageDataUrl={imageDataUrl}
        imageLoading={imageLoading}
        imageRef={imageRef}
        originalImageDataUrl={originalImageDataUrl}
        originalImageOpacity={originalImageOpacity}
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
          <SoundEffectReviewStageLayer
            disabled={blockPointerDisabled}
            onDismissRegion={onDismissSoundEffectReviewRegion}
            onExit={onExitSoundEffectReview}
            onOpenBatch={onOpenSoundEffectTranslation}
            onSelectRegion={onSelectSoundEffectReviewRegion}
            onTranslateRegion={onTranslateSoundEffectReviewRegion}
            page={page}
            selectedRegionId={selectedSoundEffectReviewRegionId ?? null}
            visible={showSoundEffectReview === true}
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

function BaseImageLayers({
  imageDataUrl,
  imageLoading = false,
  imageRef,
  originalImageDataUrl = "",
  originalImageOpacity = 0,
  page,
}: Pick<
  ImageStageLayerSetProps,
  | "imageDataUrl"
  | "imageLoading"
  | "imageRef"
  | "originalImageDataUrl"
  | "originalImageOpacity"
  | "page"
>): React.JSX.Element {
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
    </>
  );
}

type SoundEffectReviewStageLayerProps = React.ComponentProps<
  typeof SoundEffectReviewLayer
>;

function SoundEffectReviewStageLayer({
  visible,
  onDismissRegion,
  onExit,
  onOpenBatch,
  onSelectRegion,
  onTranslateRegion,
  ...props
}: Partial<SoundEffectReviewStageLayerProps> &
  Pick<SoundEffectReviewStageLayerProps, "page">): React.JSX.Element | null {
  if (
    !visible ||
    !onDismissRegion ||
    !onExit ||
    !onOpenBatch ||
    !onSelectRegion ||
    !onTranslateRegion
  ) {
    return null;
  }
  return (
    <SoundEffectReviewLayer
      {...props}
      onDismissRegion={onDismissRegion}
      onExit={onExit}
      onOpenBatch={onOpenBatch}
      onSelectRegion={onSelectRegion}
      onTranslateRegion={onTranslateRegion}
      selectedRegionId={props.selectedRegionId ?? null}
      visible
    />
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
