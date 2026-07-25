import React from "react";
import { useTranslation } from "react-i18next";
import type { BBox } from "../../../shared/textTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { ViewportSize } from "../lib/overlayLayout";
import {
  useBlockCreateRectPreview,
  useRegionSelectionRectPreview,
} from "../lib/workspaceInteractionPreview";
import { resolveRetouchCanvasBackingSize } from "../lib/retouchLiveGeometry";
import type { ImageStageProps, RetouchStageModel } from "./imageStageTypes";

type StageImageProps = {
  imageDataUrl: string;
  imageRef: React.RefObject<HTMLImageElement | null>;
  page: MangaPage;
};

export const StageImage = React.memo(function StageImage({
  imageDataUrl,
  imageRef,
  page,
}: StageImageProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return imageDataUrl ? (
    <img
      ref={imageRef}
      className="page-image"
      src={imageDataUrl}
      alt={page.name}
      draggable={false}
    />
  ) : (
    <div
      className="page-image-placeholder"
      style={{ aspectRatio: `${page.width} / ${page.height}` }}
    >
      {t("imageStage.loadingImage")}
    </div>
  );
}, areStageImagePropsEqual);

function areStageImagePropsEqual(
  previous: StageImageProps,
  next: StageImageProps,
): boolean {
  return (
    previous.imageDataUrl === next.imageDataUrl &&
    previous.imageRef === next.imageRef &&
    previous.page.id === next.page.id &&
    previous.page.name === next.page.name
  );
}

type CommittedMaskLayerProps = {
  imageDataUrl: string;
  page: MangaPage;
  retouchModel: RetouchStageModel;
  stageSize: ViewportSize | null;
};

export const CommittedMaskLayer = React.memo(function CommittedMaskLayer({
  imageDataUrl,
  page,
  retouchModel,
  stageSize,
}: CommittedMaskLayerProps): React.JSX.Element | null {
  if (
    !imageDataUrl ||
    !stageSize ||
    retouchModel.maskStrokePaths.length === 0
  ) {
    return null;
  }
  return (
    <svg
      className="retouch-preview-layer retouch-preview-mask retouch-preview-committed-mask"
      viewBox={`0 0 ${page.width} ${page.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {retouchModel.maskStrokePaths.map((stroke, index) => (
        <path
          key={index}
          d={stroke.path}
          strokeWidth={stroke.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ))}
    </svg>
  );
}, areCommittedMaskLayerPropsEqual);

function areCommittedMaskLayerPropsEqual(
  previous: CommittedMaskLayerProps,
  next: CommittedMaskLayerProps,
): boolean {
  return (
    previous.imageDataUrl === next.imageDataUrl &&
    previous.page.height === next.page.height &&
    previous.page.id === next.page.id &&
    previous.page.width === next.page.width &&
    previous.retouchModel === next.retouchModel &&
    previous.stageSize?.height === next.stageSize?.height &&
    previous.stageSize?.width === next.stageSize?.width
  );
}

export const RetouchLiveLayer = React.memo(function RetouchLiveLayer({
  retouchCursor,
  retouchOriginalImageDataUrl,
  stageSize,
}: {
  retouchCursor: ImageStageProps["retouchCursor"];
  retouchOriginalImageDataUrl: string;
  stageSize: ViewportSize | null;
}): React.JSX.Element | null {
  if (!retouchCursor) return null;
  const canvasSize = stageSize
    ? resolveRetouchCanvasBackingSize(stageSize.width, stageSize.height)
    : { height: 1, width: 1 };
  return (
    <>
      <canvas
        aria-hidden="true"
        className="retouch-live-canvas"
        data-retouch-live-canvas=""
        height={canvasSize.height}
        hidden
        width={canvasSize.width}
      />
      {retouchCursor.mode === "eraser" && retouchOriginalImageDataUrl ? (
        <img
          alt=""
          aria-hidden="true"
          className="retouch-original-source"
          data-retouch-original-source=""
          src={retouchOriginalImageDataUrl}
        />
      ) : null}
      <div
        aria-hidden="true"
        className={`retouch-cursor retouch-cursor-${retouchCursor.mode}`}
        data-retouch-live-cursor=""
        style={
          {
            "--retouch-cursor-color": retouchCursor.color,
          } as React.CSSProperties
        }
      >
        <span />
      </div>
    </>
  );
});

/** Region-translate marquee plus the block tool's create marquee. */
export const StageMarqueeLayers = React.memo(function StageMarqueeLayers({
  imageDataUrl,
  interactionPreviewStore,
  regionSelectionActive,
  regionSelectionRect,
  stageSize,
}: Pick<
  ImageStageProps,
  | "imageDataUrl"
  | "interactionPreviewStore"
  | "regionSelectionActive"
  | "regionSelectionRect"
  | "stageSize"
>): React.JSX.Element {
  const blockCreateRect = useBlockCreateRectPreview(interactionPreviewStore);
  const liveRegionSelectionRect = useRegionSelectionRectPreview(
    interactionPreviewStore,
  );
  const resolvedRegionSelectionRect =
    liveRegionSelectionRect ?? regionSelectionRect;
  return (
    <>
      <RegionSelectionLayer
        imageDataUrl={imageDataUrl}
        regionSelectionActive={regionSelectionActive}
        regionSelectionRect={resolvedRegionSelectionRect}
        stageSize={stageSize}
      />
      <RegionSelectionLayer
        imageDataUrl={imageDataUrl}
        regionSelectionActive={Boolean(blockCreateRect)}
        regionSelectionRect={blockCreateRect ?? null}
        stageSize={stageSize}
      />
    </>
  );
});

function RegionSelectionLayer({
  imageDataUrl,
  regionSelectionActive,
  regionSelectionRect,
  stageSize,
}: Pick<
  ImageStageProps,
  "imageDataUrl" | "regionSelectionActive" | "regionSelectionRect" | "stageSize"
>): React.JSX.Element | null {
  if (
    !imageDataUrl ||
    !stageSize ||
    !regionSelectionActive ||
    !regionSelectionRect
  ) {
    return null;
  }
  return (
    <div
      className="region-selection-box"
      style={resolveRegionSelectionStyle(regionSelectionRect, stageSize)}
    />
  );
}

function resolveRegionSelectionStyle(
  rect: BBox,
  stageSize: ViewportSize,
): React.CSSProperties {
  return {
    left: `${(rect.x / 1000) * stageSize.width}px`,
    top: `${(rect.y / 1000) * stageSize.height}px`,
    width: `${(rect.w / 1000) * stageSize.width}px`,
    height: `${(rect.h / 1000) * stageSize.height}px`,
  };
}
