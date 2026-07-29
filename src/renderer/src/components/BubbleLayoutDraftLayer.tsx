import React from "react";
import type { BubbleShapeRegion } from "../../../shared/bubbleLayout";
import type { Point } from "../../../shared/textTypes";
import type { ViewportSize } from "../lib/overlayLayout";
import {
  useBubbleLayoutDraftPreview,
  type BubbleLayoutDraftMode,
  type BubbleLayoutDraftPreview,
  type BubbleLayoutDraftShape,
  type WorkspaceInteractionPreviewStore,
} from "../lib/workspaceInteractionPreview";
import { CircularBrushCursor } from "./CircularBrushCursor";

const BUBBLE_BRUSH_CURSOR_COLOR = "#78f2c5";

export function BubbleLayoutDraftLayer({
  imageDataUrl,
  interactionPreviewStore,
  stageSize,
}: {
  imageDataUrl: string;
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
  stageSize: ViewportSize | null;
}): React.JSX.Element | null {
  const draft = useBubbleLayoutDraftPreview(interactionPreviewStore);
  if (!imageDataUrl || !draft) return null;
  return (
    <>
      <BubbleLayoutDraftSvg draft={draft} />
      <BubbleLayoutBrushCursor draft={draft} stageSize={stageSize} />
    </>
  );
}

function BubbleLayoutDraftSvg({
  draft,
}: {
  draft: BubbleLayoutDraftPreview;
}): React.JSX.Element {
  const previewPoints = draft.hoverPoint
    ? [...draft.points, draft.hoverPoint]
    : draft.points;
  return (
    <svg
      aria-hidden="true"
      className="bubble-layout-draft-layer"
      data-bubble-layout-draft=""
      focusable="false"
      preserveAspectRatio="none"
      viewBox="0 0 1000 1000"
    >
      {draft.shape && (draft.mode !== "polygon" || draft.points.length < 3) ? (
        <BubbleLayoutDraftShapeSvg mode={draft.mode} shape={draft.shape} />
      ) : null}
      {draft.points.length >= 3 ? (
        <polygon
          className="bubble-layout-draft-fill"
          points={formatPoints(draft.points)}
        />
      ) : null}
      {previewPoints.length >= 2 ? (
        <polyline
          className="bubble-layout-draft-line"
          points={formatPoints(previewPoints)}
        />
      ) : null}
      {draft.points.map((point, index) => (
        <circle
          className={index === 0 ? "first" : undefined}
          cx={point.x}
          cy={point.y}
          data-bubble-layout-point={index}
          key={index}
          r={index === 0 ? 7 : 5}
        />
      ))}
      {draft.mode !== "polygon" && draft.stroke?.points.length ? (
        <polyline
          className={`bubble-layout-brush-stroke ${draft.mode}`}
          points={formatPoints(draft.stroke.points)}
          strokeWidth={draft.brushRadius * 2}
        />
      ) : null}
    </svg>
  );
}

function BubbleLayoutBrushCursor({
  draft,
  stageSize,
}: {
  draft: BubbleLayoutDraftPreview;
  stageSize: ViewportSize | null;
}): React.JSX.Element | null {
  if (draft.mode === "polygon" || !draft.hoverPoint || !stageSize) {
    return null;
  }
  const scaleX = stageSize.width / 1000;
  const scaleY = stageSize.height / 1000;
  const radius = Math.max(3, draft.brushRadius * Math.min(scaleX, scaleY));
  return (
    <CircularBrushCursor
      className={`bubble-layout-brush-cursor ${draft.mode}`}
      color={BUBBLE_BRUSH_CURSOR_COLOR}
      kind="bubble-layout"
      style={{
        height: `${radius * 2}px`,
        transform: `translate3d(${draft.hoverPoint.x * scaleX}px, ${draft.hoverPoint.y * scaleY}px, 0) translate(-50%, -50%)`,
        width: `${radius * 2}px`,
      }}
    />
  );
}

function BubbleLayoutDraftShapeSvg({
  mode,
  shape,
}: {
  mode: BubbleLayoutDraftMode;
  shape: BubbleLayoutDraftShape;
}): React.JSX.Element {
  return (
    <g className={`bubble-layout-draft-shape ${mode}`}>
      {shape.bubbleLayout.regions.map((region, index) => (
        <polygon
          data-bubble-draft-region={index}
          key={index}
          points={regionPagePolygonPoints(
            region,
            shape.bubbleLayout.direction,
            shape,
          )}
        />
      ))}
    </g>
  );
}

function regionPagePolygonPoints(
  region: BubbleShapeRegion,
  direction: "horizontal" | "vertical",
  shape: BubbleLayoutDraftShape,
): string {
  const leading: Point[] = [];
  const trailing: Point[] = [];
  for (const span of region.spans) {
    const corners = resolveSpanCorners(span, direction);
    leading.push(corners.leadingStart, corners.leadingEnd);
    trailing.unshift(corners.trailingEnd, corners.trailingStart);
  }
  return [...leading, ...trailing]
    .map((point) => mapShapePointToPage(point, shape.renderBbox))
    .map((point) => `${formatCoordinate(point.x)},${formatCoordinate(point.y)}`)
    .join(" ");
}

function resolveSpanCorners(
  span: BubbleShapeRegion["spans"][number],
  direction: "horizontal" | "vertical",
): {
  leadingStart: Point;
  leadingEnd: Point;
  trailingEnd: Point;
  trailingStart: Point;
} {
  if (direction === "horizontal") {
    return {
      leadingStart: { x: span.inlineStart, y: span.blockStart },
      leadingEnd: { x: span.inlineStart, y: span.blockEnd },
      trailingEnd: { x: span.inlineEnd, y: span.blockEnd },
      trailingStart: { x: span.inlineEnd, y: span.blockStart },
    };
  }
  return {
    leadingStart: { x: span.blockStart, y: span.inlineStart },
    leadingEnd: { x: span.blockEnd, y: span.inlineStart },
    trailingEnd: { x: span.blockEnd, y: span.inlineEnd },
    trailingStart: { x: span.blockStart, y: span.inlineEnd },
  };
}

function mapShapePointToPage(
  point: Point,
  bbox: BubbleLayoutDraftShape["renderBbox"],
): Point {
  return {
    x: bbox.x + point.x * bbox.w,
    y: bbox.y + point.y * bbox.h,
  };
}

function formatPoints(points: readonly Point[]): string {
  return points
    .map((point) => `${formatCoordinate(point.x)},${formatCoordinate(point.y)}`)
    .join(" ");
}

function formatCoordinate(value: number): string {
  return Number(value.toFixed(2)).toString();
}
