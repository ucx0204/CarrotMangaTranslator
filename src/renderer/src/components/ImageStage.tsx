import React from "react";
import type { BBox, InpaintingMaskStroke, MangaPage, TranslationBlock } from "../../../shared/types";
import type { ViewportSize } from "../lib/overlayLayout";
import { OverlayBlock } from "./OverlayBlock";

type ImageStageProps = {
  page: MangaPage;
  imageDataUrl: string;
  imageRef: React.RefObject<HTMLImageElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  stageSize: ViewportSize | null;
  selectedBlockId: string | null;
  showTextBlocks: boolean;
  showBlockChrome: boolean;
  highlightBlockType: TranslationBlock["type"] | null;
  blockPointerDisabled?: boolean;
  retouchCursor?: {
    point: { x: number; y: number } | null;
    radiusPx: number;
    mode: "brush" | "eraser" | "mask";
    color: string;
  } | null;
  retouchPreview?: {
    mode: "brush" | "eraser" | "mask";
    points: Array<{ x: number; y: number }>;
    radiusPx: number;
    color: string;
    originalImageDataUrl: string;
  } | null;
  maskStrokes?: InpaintingMaskStroke[];
  regionSelectionActive: boolean;
  regionSelectionRect: BBox | null;
  onStagePointerMove: (event: React.PointerEvent) => void;
  onStagePointerUp: (event: React.PointerEvent) => void;
  onStagePointerDown: (event: React.PointerEvent) => void;
  onStagePointerLeave?: (event: React.PointerEvent) => void;
  onBlockPointerDown: (event: React.PointerEvent, block: TranslationBlock, mode: "move" | "resize") => void;
};

export function ImageStage({
  page,
  imageDataUrl,
  imageRef,
  stageRef,
  stageSize,
  selectedBlockId,
  showTextBlocks,
  showBlockChrome,
  highlightBlockType,
  blockPointerDisabled = false,
  retouchCursor = null,
  retouchPreview = null,
  maskStrokes = [],
  regionSelectionActive,
  regionSelectionRect,
  onStagePointerMove,
  onStagePointerUp,
  onStagePointerDown,
  onStagePointerLeave,
  onBlockPointerDown
}: ImageStageProps): React.JSX.Element {
  const clipId = React.useId();
  const cursorVisible = Boolean(retouchCursor?.point && stageSize);
  const cursorScaleX = stageSize ? stageSize.width / Math.max(1, page.width) : 1;
  const cursorScaleY = stageSize ? stageSize.height / Math.max(1, page.height) : 1;
  const cursorRadius = retouchCursor ? Math.max(3, retouchCursor.radiusPx * Math.min(cursorScaleX, cursorScaleY)) : 0;
  const previewPath = retouchPreview?.points.length ? pointsToPath(retouchPreview.points) : "";
  const previewStrokeWidth = retouchPreview ? Math.max(1, retouchPreview.radiusPx * 2) : 0;
  const maskStrokePaths = maskStrokes
    .map((stroke) => ({
      path: pointsToPath(stroke.points),
      width: Math.max(1, stroke.radiusPx * 2)
    }))
    .filter((stroke) => stroke.path);

  return (
    <div className="stage-wrap">
      <div
        ref={stageRef}
        className={[
          "image-stage",
          regionSelectionActive ? "selecting-region" : "",
          blockPointerDisabled ? "editing-mask" : "",
          retouchCursor ? "retouch-tool-enabled" : "",
          cursorVisible ? "retouch-cursor-active" : ""
        ]
          .filter(Boolean)
          .join(" ")}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
        onPointerLeave={onStagePointerLeave}
        onPointerDown={onStagePointerDown}
      >
        {imageDataUrl ? (
          <img ref={imageRef} className="page-image" src={imageDataUrl} alt={page.name} draggable={false} />
        ) : (
          <div className="page-image-placeholder" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
            이미지 불러오는 중
          </div>
        )}
        {imageDataUrl && stageSize && showTextBlocks
          ? page.blocks.map((block) => (
              <OverlayBlock
                key={block.id}
                block={block}
                pageSize={{ width: page.width, height: page.height }}
                stageSize={stageSize}
                selected={block.id === selectedBlockId}
                showChrome={showBlockChrome}
                highlightType={highlightBlockType}
                pointerDisabled={blockPointerDisabled}
                onPointerDown={(event) => onBlockPointerDown(event, block, "move")}
                onResizePointerDown={(event) => onBlockPointerDown(event, block, "resize")}
              />
            ))
          : null}
        {imageDataUrl && stageSize && maskStrokePaths.length > 0 ? (
          <svg
            className="retouch-preview-layer retouch-preview-mask retouch-preview-committed-mask"
            viewBox={`0 0 ${page.width} ${page.height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {maskStrokePaths.map((stroke, index) => (
              <path key={index} d={stroke.path} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            ))}
          </svg>
        ) : null}
        {imageDataUrl && stageSize && retouchPreview && previewPath ? (
          <svg
            className={`retouch-preview-layer retouch-preview-${retouchPreview.mode}`}
            viewBox={`0 0 ${page.width} ${page.height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {retouchPreview.mode === "eraser" && retouchPreview.originalImageDataUrl ? (
              <>
                <defs>
                  <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
                    <path d={previewPath} stroke="#fff" strokeWidth={previewStrokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </clipPath>
                </defs>
                <image href={retouchPreview.originalImageDataUrl} x="0" y="0" width={page.width} height={page.height} clipPath={`url(#${clipId})`} />
                <path className="retouch-preview-outline" d={previewPath} strokeWidth={previewStrokeWidth} />
              </>
            ) : (
              <path d={previewPath} stroke={retouchPreview.color} strokeWidth={previewStrokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            )}
          </svg>
        ) : null}
        {cursorVisible && retouchCursor?.point && stageSize ? (
          <div
            className={`retouch-cursor retouch-cursor-${retouchCursor.mode}`}
            style={{
              left: `${retouchCursor.point.x * cursorScaleX}px`,
              top: `${retouchCursor.point.y * cursorScaleY}px`,
              width: `${cursorRadius * 2}px`,
              height: `${cursorRadius * 2}px`,
              marginLeft: `${-cursorRadius}px`,
              marginTop: `${-cursorRadius}px`,
              "--retouch-cursor-color": retouchCursor.color
            } as React.CSSProperties}
          >
            <span />
          </div>
        ) : null}
        {imageDataUrl && stageSize && regionSelectionActive && regionSelectionRect ? (
          <div
            className="region-selection-box"
            style={{
              left: `${(regionSelectionRect.x / 1000) * stageSize.width}px`,
              top: `${(regionSelectionRect.y / 1000) * stageSize.height}px`,
              width: `${(regionSelectionRect.w / 1000) * stageSize.width}px`,
              height: `${(regionSelectionRect.h / 1000) * stageSize.height}px`
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function pointsToPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) {
    return "";
  }
  if (points.length === 1) {
    const point = points[0];
    return `M ${point.x} ${point.y} L ${point.x + 0.01} ${point.y}`;
  }
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}
