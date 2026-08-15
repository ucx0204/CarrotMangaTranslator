import {
  createWarpEvaluator,
  mapPointFromQuad,
  mapPointToQuad,
  normalizePerspectiveTransform,
} from "../../../shared/blockTransforms";
import type {
  Point,
  TranslationBlock,
  WarpTransform,
} from "../../../shared/textTypes";
import type { DragMode } from "./workspaceInteractionTypes";

export type WarpGridLine = {
  index: number;
  kind: "row" | "column";
  pointIndexes: number[];
  points: Point[];
};

export function resolveWarpDisplayPoints(
  block: TranslationBlock,
  transform: WarpTransform,
): Point[] {
  const displayPoint = resolvePerspectivePointMapper(block);
  return transform.points.map(displayPoint);
}

export function resolveWarpGridLines(
  block: TranslationBlock,
  transform: WarpTransform,
): WarpGridLine[] {
  const evaluator = createWarpEvaluator(transform);
  const displayPoint = resolvePerspectivePointMapper(block);
  const side = transform.gridSize + 1;
  const sampleCount = transform.gridSize * 12;
  const rows = Array.from({ length: side }, (_, row) => ({
    index: row,
    kind: "row" as const,
    pointIndexes: Array.from(
      { length: side },
      (_value, column) => row * side + column,
    ),
    points: Array.from({ length: sampleCount + 1 }, (_value, sample) =>
      displayPoint(
        evaluator.map({ x: sample / sampleCount, y: row / transform.gridSize }),
      ),
    ),
  }));
  const columns = Array.from({ length: side }, (_, column) => ({
    index: column,
    kind: "column" as const,
    pointIndexes: Array.from(
      { length: side },
      (_value, row) => row * side + column,
    ),
    points: Array.from({ length: sampleCount + 1 }, (_value, sample) =>
      displayPoint(
        evaluator.map({
          x: column / transform.gridSize,
          y: sample / sampleCount,
        }),
      ),
    ),
  }));
  return [...rows, ...columns];
}

export function warpDragMode(indexes: readonly number[]): DragMode {
  return `warp-points-${indexes.join("_")}`;
}

export function moveWarpPointsByDisplayPixels({
  block,
  height,
  indexes,
  transform,
  width,
  x,
  y,
}: {
  block: TranslationBlock;
  height: number;
  indexes: readonly number[];
  transform: WarpTransform;
  width: number;
  x: number;
  y: number;
}): WarpTransform {
  const primary = transform.points[indexes[0]];
  const displayDelta = {
    x: x / Math.max(1, width),
    y: y / Math.max(1, height),
  };
  let localDelta = displayDelta;
  if (block.perspectiveTransform) {
    const corners = normalizePerspectiveTransform(
      block.perspectiveTransform,
    ).corners;
    const displayed = mapPointToQuad(primary, corners);
    const next = mapPointFromQuad(
      { x: displayed.x + displayDelta.x, y: displayed.y + displayDelta.y },
      corners,
    );
    localDelta = { x: next.x - primary.x, y: next.y - primary.y };
  }
  const selected = new Set(indexes);
  return {
    ...transform,
    points: transform.points.map((point, index) =>
      selected.has(index)
        ? { x: point.x + localDelta.x, y: point.y + localDelta.y }
        : { ...point },
    ),
  };
}

export function arrowKeyDelta(key: string): Point | null {
  if (key === "ArrowLeft") return { x: -1, y: 0 };
  if (key === "ArrowRight") return { x: 1, y: 0 };
  if (key === "ArrowUp") return { x: 0, y: -1 };
  if (key === "ArrowDown") return { x: 0, y: 1 };
  return null;
}

function resolvePerspectivePointMapper(
  block: TranslationBlock,
): (point: Point) => Point {
  if (!block.perspectiveTransform) return (point) => point;
  const corners = normalizePerspectiveTransform(
    block.perspectiveTransform,
  ).corners;
  return (point) => mapPointToQuad(point, corners);
}
