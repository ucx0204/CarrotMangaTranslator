import React from "react";
import { useTranslation } from "react-i18next";
import { isValidWarpTransform } from "../../../shared/blockTransforms";
import type {
  Point,
  TranslationBlock,
  WarpTransform,
} from "../../../shared/textTypes";
import { useWarpPointSelection } from "../lib/warpPointSelection";
import { isWarpVisibleOnPage } from "../lib/transformEditorModel";
import {
  arrowKeyDelta,
  moveWarpPointsByDisplayPixels,
  resolveWarpDisplayPoints,
  resolveWarpGridLines,
  warpDragMode,
  type WarpGridLine,
} from "../lib/warpOverlayGeometry";
import type { DragMode } from "../lib/workspaceInteractionTypes";

type WarpOverlayProps = {
  block: TranslationBlock;
  height: number;
  onPointerDown: (event: React.PointerEvent, mode: DragMode) => void;
  onWarpTransformCommit?: (transform: WarpTransform) => void;
  pageSize: { width: number; height: number };
  transform: WarpTransform;
  width: number;
};

type WarpMarquee = {
  start: Point;
  current: Point;
  pointerId: number;
};

type SelectionSetter = (indexes: readonly number[]) => void;

export function WarpOverlayControls({
  block,
  height,
  onPointerDown,
  onWarpTransformCommit,
  pageSize,
  transform,
  width,
}: WarpOverlayProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [selected, setSelected] = useWarpPointSelection(
    block.id,
    transform.points.length,
  );
  const [marquee, setMarquee] = React.useState<WarpMarquee | null>(null);
  useCancelWarpMarquee(marquee, setMarquee);
  const displayPoints = resolveWarpDisplayPoints(block, transform);
  const gridLines = resolveWarpGridLines(block, transform);
  return (
    <div className="overlay-transform-controls warp-controls">
      <WarpMarqueeSurface
        displayPoints={displayPoints}
        marquee={marquee}
        selected={selected}
        setMarquee={setMarquee}
        setSelected={setSelected}
      />
      <WarpGridGuide
        gridLines={gridLines}
        height={height}
        marquee={marquee}
        onPointerDown={onPointerDown}
        setSelected={setSelected}
        width={width}
      />
      <WarpPointHandles
        block={block}
        displayPoints={displayPoints}
        height={height}
        onPointerDown={onPointerDown}
        onWarpTransformCommit={onWarpTransformCommit}
        pageSize={pageSize}
        selected={selected}
        setSelected={setSelected}
        transform={transform}
        width={width}
      />
      <span className="visually-hidden" aria-live="polite">
        {t("transform.warp.selectionCount", { count: selected.length })}
      </span>
    </div>
  );
}

function useCancelWarpMarquee(
  marquee: WarpMarquee | null,
  setMarquee: React.Dispatch<React.SetStateAction<WarpMarquee | null>>,
): void {
  React.useEffect(() => {
    if (!marquee) return;
    const cancel = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMarquee(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [marquee, setMarquee]);
}

function WarpMarqueeSurface({
  displayPoints,
  marquee,
  selected,
  setMarquee,
  setSelected,
}: {
  displayPoints: readonly Point[];
  marquee: WarpMarquee | null;
  selected: readonly number[];
  setMarquee: React.Dispatch<React.SetStateAction<WarpMarquee | null>>;
  setSelected: SelectionSetter;
}): React.JSX.Element {
  const finish = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!marquee || event.pointerId !== marquee.pointerId) return;
    const bounds = normalizeSelectionRect(
      marquee.start,
      pointerToLocal(event, event.currentTarget),
    );
    const matches = displayPoints
      .map((point, index) => ({ index, point }))
      .filter(({ point }) => pointInsideRect(point, bounds))
      .map(({ index }) => index);
    setSelected(Array.from(new Set([...selected, ...matches])));
    setMarquee(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div
      className="warp-selection-surface"
      onPointerDown={(event) => {
        if (!event.shiftKey) return;
        const start = pointerToLocal(event, event.currentTarget);
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setMarquee({ start, current: start, pointerId: event.pointerId });
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerMove={(event) => {
        if (!marquee || event.pointerId !== marquee.pointerId) return;
        setMarquee({
          ...marquee,
          current: pointerToLocal(event, event.currentTarget),
        });
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerCancel={() => setMarquee(null)}
      onPointerUp={finish}
    />
  );
}

function WarpGridGuide({
  gridLines,
  height,
  marquee,
  onPointerDown,
  setSelected,
  width,
}: {
  gridLines: WarpGridLine[];
  height: number;
  marquee: WarpMarquee | null;
  onPointerDown: WarpOverlayProps["onPointerDown"];
  setSelected: SelectionSetter;
  width: number;
}): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      className="transform-guide warp-grid-guide"
      viewBox={`0 0 ${width} ${height}`}
    >
      {gridLines.map((line) => (
        <polyline
          className={`warp-grid-line warp-grid-${line.kind}`}
          key={`${line.kind}-${line.index}`}
          onPointerDown={(event) => {
            setSelected(line.pointIndexes);
            onPointerDown(event, warpDragMode(line.pointIndexes));
          }}
          points={line.points
            .map((point) => formatPoint(toPixels(point, width, height)))
            .join(" ")}
        />
      ))}
      {marquee ? (
        <rect
          className="warp-selection-rect"
          {...selectionRectSvgProps(
            normalizeSelectionRect(marquee.start, marquee.current),
            width,
            height,
          )}
        />
      ) : null}
    </svg>
  );
}

function WarpPointHandles({
  block,
  displayPoints,
  height,
  onPointerDown,
  onWarpTransformCommit,
  pageSize,
  selected,
  setSelected,
  transform,
  width,
}: WarpOverlayProps & {
  displayPoints: readonly Point[];
  selected: readonly number[];
  setSelected: SelectionSetter;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const side = transform.gridSize + 1;
  const startDrag = (event: React.PointerEvent, index: number): void => {
    const next = resolvePointSelection(selected, index, event.shiftKey);
    setSelected(next);
    if (!next.includes(index)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onPointerDown(event, warpDragMode(next));
  };
  const nudge = (event: React.KeyboardEvent, index: number): void => {
    const direction = arrowKeyDelta(event.key);
    if (!direction || !onWarpTransformCommit) return;
    event.preventDefault();
    event.stopPropagation();
    const indexes = selected.includes(index) ? selected : [index];
    setSelected(indexes);
    const amount = event.shiftKey ? 10 : 1;
    const next = moveWarpPointsByDisplayPixels({
      block,
      height,
      indexes,
      transform,
      width,
      x: direction.x * amount,
      y: direction.y * amount,
    });
    if (
      isValidWarpTransform(next) &&
      isWarpVisibleOnPage(block, next, pageSize)
    ) {
      onWarpTransformCommit(next);
    }
  };
  return (
    <>
      {displayPoints.map((point, index) => (
        <button
          aria-label={t("transform.warp.pointAccessibleLabel", {
            column: (index % side) + 1,
            row: Math.floor(index / side) + 1,
          })}
          aria-pressed={selected.includes(index)}
          className={`transform-handle warp-point${selected.includes(index) ? " selected" : ""}`}
          data-transform-handle={`warp-point-${index}`}
          key={index}
          onKeyDown={(event) => nudge(event, index)}
          onPointerDown={(event) => startDrag(event, index)}
          style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
          type="button"
        />
      ))}
    </>
  );
}

function resolvePointSelection(
  selected: readonly number[],
  index: number,
  additive: boolean,
): number[] {
  if (!additive) return selected.includes(index) ? [...selected] : [index];
  return selected.includes(index)
    ? selected.filter((entry) => entry !== index)
    : [...selected, index];
}

function pointerToLocal(
  event: Pick<React.PointerEvent, "clientX" | "clientY">,
  target: HTMLElement,
): Point {
  const rect = target.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / Math.max(1, rect.width),
    y: (event.clientY - rect.top) / Math.max(1, rect.height),
  };
}

function normalizeSelectionRect(
  start: Point,
  end: Point,
): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  return {
    left: Math.min(start.x, end.x),
    right: Math.max(start.x, end.x),
    top: Math.min(start.y, end.y),
    bottom: Math.max(start.y, end.y),
  };
}

function pointInsideRect(
  point: Point,
  rect: { left: number; right: number; top: number; bottom: number },
): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function selectionRectSvgProps(
  rect: { left: number; right: number; top: number; bottom: number },
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.left * width,
    y: rect.top * height,
    width: (rect.right - rect.left) * width,
    height: (rect.bottom - rect.top) * height,
  };
}

function toPixels(point: Point, width: number, height: number): Point {
  return { x: point.x * width, y: point.y * height };
}

function formatPoint(point: Point): string {
  return `${point.x},${point.y}`;
}
