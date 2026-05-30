import React from "react";
import type { BBox, MangaPage, TranslationBlock } from "../../../shared/types";
import type { ViewportSize } from "../lib/overlayLayout";
import { OverlayBlock } from "./OverlayBlock";

type ImageStageProps = {
  page: MangaPage;
  imageDataUrl: string;
  imageRef: React.RefObject<HTMLImageElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  stageSize: ViewportSize | null;
  selectedBlockId: string | null;
  regionSelectionActive: boolean;
  regionSelectionRect: BBox | null;
  onStagePointerMove: (event: React.PointerEvent) => void;
  onStagePointerUp: (event: React.PointerEvent) => void;
  onStagePointerDown: (event: React.PointerEvent) => void;
  onBlockPointerDown: (event: React.PointerEvent, block: TranslationBlock, mode: "move" | "resize") => void;
};

export function ImageStage({
  page,
  imageDataUrl,
  imageRef,
  stageRef,
  stageSize,
  selectedBlockId,
  regionSelectionActive,
  regionSelectionRect,
  onStagePointerMove,
  onStagePointerUp,
  onStagePointerDown,
  onBlockPointerDown
}: ImageStageProps): React.JSX.Element {
  return (
    <div className="stage-wrap">
      <div
        ref={stageRef}
        className={`image-stage ${regionSelectionActive ? "selecting-region" : ""}`}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
        onPointerDown={onStagePointerDown}
      >
        {imageDataUrl ? (
          <img ref={imageRef} className="page-image" src={imageDataUrl} alt={page.name} draggable={false} />
        ) : (
          <div className="page-image-placeholder" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
            이미지 불러오는 중
          </div>
        )}
        {imageDataUrl && stageSize
          ? page.blocks.map((block) => (
              <OverlayBlock
                key={block.id}
                block={block}
                pageSize={{ width: page.width, height: page.height }}
                stageSize={stageSize}
                selected={block.id === selectedBlockId}
                onPointerDown={(event) => onBlockPointerDown(event, block, "move")}
                onResizePointerDown={(event) => onBlockPointerDown(event, block, "resize")}
              />
            ))
          : null}
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
