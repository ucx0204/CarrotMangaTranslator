import React from "react";
import { useTranslation } from "react-i18next";
import type { BBox } from "../../../shared/textTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { DragHud } from "../hooks/useWorkspacePointerHandlers";
import type { ViewportSize } from "../lib/overlayLayout";
import { OverlayBlock } from "./OverlayBlock";
import type { ImageStageProps, RetouchStageModel } from "./imageStageTypes";

export function StageImage({
  imageDataUrl,
  imageRef,
  page,
}: {
  imageDataUrl: string;
  imageRef: React.RefObject<HTMLImageElement | null>;
  page: MangaPage;
}): React.JSX.Element {
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
}

export function OverlayBlockLayer({
  blockPointerDisabled,
  imageDataUrl,
  inpaintingMode,
  onBlockPointerDown,
  onToggleBlockExcluded,
  page,
  selectedBlockId,
  selectedBlockIds,
  showBlockChrome,
  showTextBlocks,
  stageSize,
  textLayoutStageSize,
}: Pick<
  ImageStageProps,
  | "blockPointerDisabled"
  | "imageDataUrl"
  | "inpaintingMode"
  | "onBlockPointerDown"
  | "onToggleBlockExcluded"
  | "page"
  | "selectedBlockId"
  | "selectedBlockIds"
  | "showBlockChrome"
  | "showTextBlocks"
  | "stageSize"
  | "textLayoutStageSize"
>): React.JSX.Element | null {
  if (!imageDataUrl || !stageSize || !showTextBlocks) {
    return null;
  }
  const multiSelection = selectedBlockIds && selectedBlockIds.length > 1;
  const multiSelectedIds = multiSelection ? new Set(selectedBlockIds) : null;
  return (
    <>
      {page.blocks.map((block) => (
        <OverlayBlock
          key={block.id}
          block={block}
          pageSize={{ width: page.width, height: page.height }}
          stageSize={stageSize}
          selected={block.id === selectedBlockId}
          multiSelected={multiSelectedIds?.has(block.id) ?? false}
          showChrome={showBlockChrome}
          showExcluded={inpaintingMode ?? false}
          textLayoutStageSize={textLayoutStageSize}
          pointerDisabled={blockPointerDisabled ?? false}
          onPointerDown={(event) => onBlockPointerDown(event, block, "move")}
          onResizePointerDown={(event) =>
            onBlockPointerDown(event, block, "resize")
          }
          onToggleExcluded={resolveToggleBlockExcluded(
            onToggleBlockExcluded,
            block.id,
          )}
        />
      ))}
    </>
  );
}

export function CommittedMaskLayer({
  imageDataUrl,
  page,
  retouchModel,
  stageSize,
}: {
  imageDataUrl: string;
  page: MangaPage;
  retouchModel: RetouchStageModel;
  stageSize: ViewportSize | null;
}): React.JSX.Element | null {
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
}

export function RetouchPreviewLayer({
  clipId,
  imageDataUrl,
  page,
  retouchModel,
  retouchPreview,
  stageSize,
}: {
  clipId: string;
  imageDataUrl: string;
  page: MangaPage;
  retouchModel: RetouchStageModel;
  retouchPreview: ImageStageProps["retouchPreview"];
  stageSize: ViewportSize | null;
}): React.JSX.Element | null {
  if (
    !imageDataUrl ||
    !stageSize ||
    !retouchPreview ||
    !retouchModel.previewPath
  ) {
    return null;
  }
  return (
    <svg
      className={`retouch-preview-layer retouch-preview-${retouchPreview.mode}`}
      viewBox={`0 0 ${page.width} ${page.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {retouchPreview.mode === "eraser" &&
      retouchPreview.originalImageDataUrl ? (
        <RetouchEraserPreview
          clipId={clipId}
          page={page}
          preview={retouchPreview}
          retouchModel={retouchModel}
        />
      ) : (
        <path
          d={retouchModel.previewPath}
          stroke={retouchPreview.color}
          strokeWidth={retouchModel.previewStrokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}
    </svg>
  );
}

function RetouchEraserPreview({
  clipId,
  page,
  preview,
  retouchModel,
}: {
  clipId: string;
  page: MangaPage;
  preview: NonNullable<ImageStageProps["retouchPreview"]>;
  retouchModel: RetouchStageModel;
}): React.JSX.Element {
  return (
    <>
      <defs>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <path
            d={retouchModel.previewPath}
            stroke="#fff"
            strokeWidth={retouchModel.previewStrokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </clipPath>
      </defs>
      <image
        href={preview.originalImageDataUrl}
        x="0"
        y="0"
        width={page.width}
        height={page.height}
        clipPath={`url(#${clipId})`}
      />
      <path
        className="retouch-preview-outline"
        d={retouchModel.previewPath}
        strokeWidth={retouchModel.previewStrokeWidth}
      />
    </>
  );
}

export function RetouchCursorLayer({
  retouchCursor,
  retouchModel,
  stageSize,
}: {
  retouchCursor: ImageStageProps["retouchCursor"];
  retouchModel: RetouchStageModel;
  stageSize: ViewportSize | null;
}): React.JSX.Element | null {
  if (!retouchModel.cursorVisible || !retouchCursor?.point || !stageSize) {
    return null;
  }
  return (
    <div
      className={`retouch-cursor retouch-cursor-${retouchCursor.mode}`}
      style={resolveRetouchCursorStyle(retouchCursor, retouchModel)}
    >
      <span />
    </div>
  );
}

/** Region-translate marquee plus the block tool's create marquee. */
export function StageMarqueeLayers({
  blockCreateRect = null,
  imageDataUrl,
  regionSelectionActive,
  regionSelectionRect,
  stageSize,
}: Pick<
  ImageStageProps,
  | "blockCreateRect"
  | "imageDataUrl"
  | "regionSelectionActive"
  | "regionSelectionRect"
  | "stageSize"
>): React.JSX.Element {
  return (
    <>
      <RegionSelectionLayer
        imageDataUrl={imageDataUrl}
        regionSelectionActive={regionSelectionActive}
        regionSelectionRect={regionSelectionRect}
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
}

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

export function StageDragHud({
  dragHud,
}: {
  dragHud: DragHud | null;
}): React.JSX.Element | null {
  return dragHud ? (
    <div className={`stage-drag-hud ${dragHud.mode}`}>{dragHud.label}</div>
  ) : null;
}

function resolveToggleBlockExcluded(
  onToggleBlockExcluded: ImageStageProps["onToggleBlockExcluded"],
  blockId: string,
): (() => void) | undefined {
  return onToggleBlockExcluded
    ? () => onToggleBlockExcluded(blockId)
    : undefined;
}

function resolveRetouchCursorStyle(
  cursor: NonNullable<ImageStageProps["retouchCursor"]>,
  retouchModel: RetouchStageModel,
): React.CSSProperties {
  return {
    left: `${(cursor.point?.x ?? 0) * retouchModel.cursorScaleX}px`,
    top: `${(cursor.point?.y ?? 0) * retouchModel.cursorScaleY}px`,
    width: `${retouchModel.cursorRadius * 2}px`,
    height: `${retouchModel.cursorRadius * 2}px`,
    marginLeft: `${-retouchModel.cursorRadius}px`,
    marginTop: `${-retouchModel.cursorRadius}px`,
    "--retouch-cursor-color": cursor.color,
  } as React.CSSProperties;
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
