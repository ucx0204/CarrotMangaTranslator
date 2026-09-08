import React from "react";
import type { Point } from "../../../shared/textTypes";
import type { LetteringMaskStroke } from "../../../shared/generatedLetteringMaskTypes";
export type RegionReviewTool =
  | "bounds"
  | "add"
  | "paint"
  | "hide"
  | "restore"
  | "pan";
import type { useRegionReviewForm } from "./useRegionReviewForm";
type Options = {
  form: ReturnType<typeof useRegionReviewForm>;
  crop: { w: number; h: number };
  tool: RegionReviewTool;
  shape: "circle" | "square";
  size: number;
  disabled?: boolean;
};
export function regionReviewPosition(
  event: { clientX: number; clientY: number },
  stage: React.RefObject<HTMLDivElement | null>,
): Point {
  const rect = stage.current?.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(
        1000,
        ((event.clientX - (rect?.left ?? 0)) * 1000) /
          Math.max(1, rect?.width ?? 1),
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        1000,
        ((event.clientY - (rect?.top ?? 0)) * 1000) /
          Math.max(1, rect?.height ?? 1),
      ),
    ),
  };
}
type ReviewGesture = {
  pointerId: number;
  tool?: RegionReviewTool;
  regionId?: string;
  stroke?: LetteringMaskStroke;
  start?: Point;
  scroll?: Point;
};
export function useReviewDrawing(
  props: Options,
  stage: React.RefObject<HTMLDivElement | null>,
  viewport: React.RefObject<HTMLDivElement | null>,
) {
  const active = React.useRef<ReviewGesture | null>(null);
  const [draft, setDraft] = React.useState<LetteringMaskStroke | null>(null);
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = active.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.stroke && gesture.stroke.points.length < 2048) {
      gesture.stroke = {
        ...gesture.stroke,
        points: [...gesture.stroke.points, regionReviewPosition(event, stage)],
      };
      setDraft(gesture.stroke);
    } else if (gesture.start && gesture.scroll && viewport.current) {
      viewport.current.scrollLeft =
        gesture.scroll.x - event.clientX + gesture.start.x;
      viewport.current.scrollTop =
        gesture.scroll.y - event.clientY + gesture.start.y;
    }
  };
  const handlers: React.HTMLAttributes<HTMLDivElement> = {
    onPointerDown: (event) => {
      if (active.current || !canDraw(event, props)) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      if (props.tool === "pan" || event.button === 1)
        active.current = {
          pointerId: event.pointerId,
          start: { x: event.clientX, y: event.clientY },
          scroll: {
            x: viewport.current?.scrollLeft ?? 0,
            y: viewport.current?.scrollTop ?? 0,
          },
        };
      else {
        const stroke = createStroke(props, regionReviewPosition(event, stage));
        if (!stroke) return;
        active.current = {
          pointerId: event.pointerId,
          stroke,
          tool: props.tool,
          regionId: props.form.focused,
        };
        setDraft(stroke);
      }
    },
    onPointerMove: move,
    onPointerUp: (event) => {
      if (active.current?.pointerId !== event.pointerId) return;
      move(event);
      if (active.current?.stroke) {
        if (active.current.tool === "paint")
          props.form.addPaintStroke(
            active.current.stroke,
            active.current.regionId,
          );
        else
          props.form.addStroke(active.current.stroke, active.current.regionId);
      }
      active.current = null;
      setDraft(null);
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onLostPointerCapture: () => {
      active.current = null;
      setDraft(null);
    },
    onPointerCancel: () => {
      active.current = null;
      setDraft(null);
    },
  };
  return { draft, handlers };
}

function canDraw(event: React.PointerEvent, props: Options) {
  if (props.disabled || event.ctrlKey || event.metaKey) return false;
  return (
    event.button === 1 ||
    (event.button === 0 && props.tool !== "bounds" && props.tool !== "add")
  );
}
function createStroke(
  props: Options,
  point: Point,
): LetteringMaskStroke | null {
  if (
    !["hide", "restore", "paint"].includes(props.tool) ||
    (props.tool !== "paint" && !props.form.focused) ||
    props.form.values.reduce(
      (sum, value) =>
        sum +
        (value.selectionStrokes?.length ?? 0) +
        (value.exclusionStrokes?.length ?? 0),
      0,
    ) >= 500
  )
    return null;
  return {
    space: "page",
    mode: props.tool === "restore" ? "restore" : "hide",
    shape: props.shape,
    softness: 0,
    radiusX: (props.size * 500) / props.crop.w,
    radiusY: (props.size * 500) / props.crop.h,
    points: [point],
  };
}
