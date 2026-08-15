import {
  mapPointFromQuad,
  mapPointToQuad,
  normalizePerspectiveTransform,
} from "../../../shared/blockTransforms";
import type {
  BBox,
  PerspectiveTransform,
  Point,
  WarpTransform,
} from "../../../shared/textTypes";
import type { DragMode } from "../lib/workspaceInteractionTypes";
import type { DragState, PointerRect } from "./workspacePointerGeometry";

export function resolveDraggedWarpTransform(
  drag: DragState,
  point: { clientX: number; clientY: number },
  transform: WarpTransform,
  rect: PointerRect,
): WarpTransform {
  const indexes = warpPointIndexesFromMode(drag.mode, transform.points.length);
  if (indexes.length === 0) return transform;
  const delta = pointerDeltaInBlockAxes(drag, point);
  const size = blockDisplaySize(drag.startBbox, rect);
  const displayDelta = {
    x: delta.x / size.width,
    y: delta.y / size.height,
  };
  const primary = transform.points[indexes[0]];
  const localDelta = resolveWarpLocalDelta(
    primary,
    displayDelta,
    drag.startBlock.perspectiveTransform,
  );
  const selected = new Set(indexes);
  return {
    ...transform,
    points: transform.points.map((value, index) =>
      selected.has(index)
        ? {
            x: clampWarpPoint(value.x + localDelta.x),
            y: clampWarpPoint(value.y + localDelta.y),
          }
        : { ...value },
    ),
  };
}

export function warpPointIndexesFromMode(
  mode: DragMode,
  pointCount: number,
): number[] {
  if (!mode.startsWith("warp-points-")) return [];
  return Array.from(
    new Set(
      mode
        .slice("warp-points-".length)
        .split("_")
        .map(Number)
        .filter(
          (index) =>
            Number.isInteger(index) && index >= 0 && index < pointCount,
        ),
    ),
  );
}

function resolveWarpLocalDelta(
  anchor: Point,
  displayDelta: Point,
  perspective: PerspectiveTransform | undefined,
): Point {
  if (!perspective) return displayDelta;
  const corners = normalizePerspectiveTransform(perspective).corners;
  const displayed = mapPointToQuad(anchor, corners);
  const next = mapPointFromQuad(
    { x: displayed.x + displayDelta.x, y: displayed.y + displayDelta.y },
    corners,
  );
  return { x: next.x - anchor.x, y: next.y - anchor.y };
}

function pointerDeltaInBlockAxes(
  drag: DragState,
  point: { clientX: number; clientY: number },
): Point {
  return rotatePoint(
    { x: point.clientX - drag.startX, y: point.clientY - drag.startY },
    -(drag.startBlock.rotationDeg ?? 0),
  );
}

function blockDisplaySize(
  bbox: BBox,
  rect: PointerRect,
): { width: number; height: number } {
  return {
    width: Math.max(1, (bbox.w / 1000) * rect.width),
    height: Math.max(1, (bbox.h / 1000) * rect.height),
  };
}

function rotatePoint(point: Point, angleDeg: number): Point {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

function clampWarpPoint(value: number): number {
  return Math.max(-4, Math.min(5, value));
}
