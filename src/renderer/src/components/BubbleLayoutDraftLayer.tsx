import React from "react";
import type { BubbleShapeRegion } from "../../../shared/bubbleLayout";
import type { Point } from "../../../shared/textTypes";
import {
  useBubbleLayoutDraftPreview,
  type BubbleLayoutDraftMode,
  type BubbleLayoutDraftPreview,
  type BubbleLayoutDraftShape,
  type WorkspaceInteractionPreviewStore,
} from "../lib/workspaceInteractionPreview";

export function BubbleLayoutDraftLayer({
  imageDataUrl,
  interactionPreviewStore,
}: {
  imageDataUrl: string;
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
}): React.JSX.Element | null {
  const draft = useBubbleLayoutDraftPreview(interactionPreviewStore);
  if (!imageDataUrl || !draft) return null;
  return <BubbleLayoutDraftSvg draft={draft} />;
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
      {draft.mode !== "polygon" && draft.hoverPoint ? (
        <circle
          className={`bubble-layout-brush-cursor ${draft.mode}`}
          cx={draft.hoverPoint.x}
          cy={draft.hoverPoint.y}
          r={draft.brushRadius}
        />
      ) : null}
    </svg>
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
