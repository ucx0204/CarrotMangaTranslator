import React from "react";
import { useTranslation } from "react-i18next";
import {
  mapPointToQuad,
  normalizePerspectiveTransform,
  quadraticPointAt,
} from "../../../shared/blockTransforms";
import type { Point, TranslationBlock } from "../../../shared/textTypes";
import type {
  DragMode,
  PerspectiveHandle,
  ResizeHandle,
} from "../lib/workspaceInteractionTypes";

export type BlockTransformMode = "select" | "perspective" | "curve";

type TransformControlsProps = {
  block: TranslationBlock;
  height: number;
  mode: BlockTransformMode;
  onPointerDown: (event: React.PointerEvent, mode: DragMode) => void;
  showCurveGuide: boolean;
  width: number;
};

const RESIZE_HANDLES: Array<{
  handle: ResizeHandle;
  key: string;
}> = [
  { handle: "nw", key: "resizeNw" },
  { handle: "n", key: "resizeN" },
  { handle: "ne", key: "resizeNe" },
  { handle: "e", key: "resizeE" },
  { handle: "se", key: "resizeSe" },
  { handle: "s", key: "resizeS" },
  { handle: "sw", key: "resizeSw" },
  { handle: "w", key: "resizeW" },
];

const PERSPECTIVE_HANDLES: Array<{
  handle: PerspectiveHandle;
  key: string;
  indexes: number[];
}> = [
  { handle: "tl", key: "perspectiveTl", indexes: [0] },
  { handle: "top", key: "perspectiveTop", indexes: [0, 1] },
  { handle: "tr", key: "perspectiveTr", indexes: [1] },
  { handle: "right", key: "perspectiveRight", indexes: [1, 2] },
  { handle: "br", key: "perspectiveBr", indexes: [2] },
  { handle: "bottom", key: "perspectiveBottom", indexes: [2, 3] },
  { handle: "bl", key: "perspectiveBl", indexes: [3] },
  { handle: "left", key: "perspectiveLeft", indexes: [3, 0] },
];

export function OverlayTransformControls(
  props: TransformControlsProps,
): React.JSX.Element | null {
  if (props.mode === "select") return <SelectionControls {...props} />;
  if (props.mode === "perspective") return <PerspectiveControls {...props} />;
  if (
    props.mode === "curve" &&
    props.showCurveGuide &&
    props.block.curveLayout
  ) {
    return <CurveControls {...props} />;
  }
  return null;
}

function SelectionControls({
  onPointerDown,
}: TransformControlsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="overlay-transform-controls selection-controls">
      <span className="rotation-stem" aria-hidden="true" />
      <TransformHandle
        className="rotation-handle"
        label={t("transform.handles.rotate")}
        mode="rotate"
        onPointerDown={onPointerDown}
      />
      {RESIZE_HANDLES.map(({ handle, key }) => (
        <TransformHandle
          className={`resize-${handle}`}
          key={handle}
          label={t(`transform.handles.${key}`)}
          mode={`resize-${handle}`}
          onPointerDown={onPointerDown}
        />
      ))}
    </div>
  );
}

function PerspectiveControls({
  block,
  height,
  onPointerDown,
  width,
}: TransformControlsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const transform = normalizePerspectiveTransform(block.perspectiveTransform);
  const points = transform.corners.map((point) =>
    toPixels(point, width, height),
  );
  return (
    <div className="overlay-transform-controls perspective-controls">
      <svg
        aria-hidden="true"
        className="transform-guide"
        viewBox={`0 0 ${width} ${height}`}
      >
        <polygon points={points.map(formatPoint).join(" ")} />
      </svg>
      {PERSPECTIVE_HANDLES.map(({ handle, indexes, key }) => {
        const point = averagePoints(
          indexes.map((index) => transform.corners[index]),
        );
        return (
          <TransformHandle
            className={`perspective-${handle}`}
            key={handle}
            label={t(`transform.handles.${key}`)}
            mode={`perspective-${handle}`}
            onPointerDown={onPointerDown}
            point={point}
          />
        );
      })}
    </div>
  );
}

function CurveControls({
  block,
  height,
  onPointerDown,
  width,
}: TransformControlsProps): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const curve = block.curveLayout;
  if (!curve) return null;
  const displayPoint = resolveDisplayPointMapper(block);
  const points = {
    start: displayPoint(curve.path.start),
    control: displayPoint(curve.path.control),
    end: displayPoint(curve.path.end),
  };
  return (
    <div className="overlay-transform-controls curve-controls">
      <svg
        aria-hidden="true"
        className="transform-guide"
        viewBox={`0 0 ${width} ${height}`}
      >
        <polyline
          className="curve-control-line"
          points={[points.start, points.control, points.end]
            .map((point) => formatPoint(toPixels(point, width, height)))
            .join(" ")}
        />
        <polyline
          className="curve-path-line"
          points={resolveCurveSamples(block, curve)
            .map((point) => formatPoint(toPixels(point, width, height)))
            .join(" ")}
        />
      </svg>
      <TransformHandle
        className="curve-start"
        label={t("transform.handles.curveStart")}
        mode="curve-start"
        onPointerDown={onPointerDown}
        point={points.start}
      />
      <TransformHandle
        className="curve-control"
        label={t("transform.handles.curveControl")}
        mode="curve-control"
        onPointerDown={onPointerDown}
        point={points.control}
      />
      <TransformHandle
        className="curve-end"
        label={t("transform.handles.curveEnd")}
        mode="curve-end"
        onPointerDown={onPointerDown}
        point={points.end}
      />
    </div>
  );
}

function TransformHandle({
  className,
  label,
  mode,
  onPointerDown,
  point,
}: {
  className: string;
  label: string;
  mode: DragMode;
  onPointerDown: TransformControlsProps["onPointerDown"];
  point?: Point;
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      className={`transform-handle ${className}`}
      data-transform-handle={mode}
      onPointerDown={(event) => onPointerDown(event, mode)}
      style={
        point
          ? { left: `${point.x * 100}%`, top: `${point.y * 100}%` }
          : undefined
      }
      type="button"
    />
  );
}

function resolveCurveSamples(
  block: TranslationBlock,
  curve: NonNullable<TranslationBlock["curveLayout"]>,
): Point[] {
  const displayPoint = resolveDisplayPointMapper(block);
  return Array.from({ length: 33 }, (_, index) =>
    displayPoint(quadraticPointAt(curve.path, index / 32)),
  );
}

function resolveDisplayPointMapper(
  block: TranslationBlock,
): (point: Point) => Point {
  if (!block.perspectiveTransform) return (point) => point;
  const corners = normalizePerspectiveTransform(
    block.perspectiveTransform,
  ).corners;
  return (point) => mapPointToQuad(point, corners);
}

function toPixels(point: Point, width: number, height: number): Point {
  return { x: point.x * width, y: point.y * height };
}

function formatPoint(point: Point): string {
  return `${point.x},${point.y}`;
}

function averagePoints(points: Point[]): Point {
  return {
    x: points.reduce((total, point) => total + point.x, 0) / points.length,
    y: points.reduce((total, point) => total + point.y, 0) / points.length,
  };
}
