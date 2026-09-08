import React from "react";
import {
  moveBbox,
  resizeBbox,
  type ResizeDirection,
} from "../../../shared/regionSelectionGeometry";
import type { BBox, Point } from "../../../shared/textTypes";
import type { useRegionReviewForm } from "./useRegionReviewForm";
import {
  regionReviewPosition,
  type RegionReviewTool,
} from "./useRegionReviewDrawing";
type Props = {
  form: ReturnType<typeof useRegionReviewForm>;
  disabled?: boolean;
  tool: RegionReviewTool;
};
type Gesture = {
  pointerId: number;
  start: Point;
  regionId: string;
  box: BBox;
  direction?: ResizeDirection;
  clientStart: Point;
  moved: boolean;
  focusedBefore?: string;
};

export function useRegionReviewBoxGestures(
  props: Props,
  stage: React.RefObject<HTMLDivElement | null>,
  regionId: string,
) {
  const drag = React.useRef<Gesture | null>(null);
  return (box: BBox, direction?: ResizeDirection) =>
    makeBoxHandlers(props, stage, drag, regionId, box, direction);
}
function makeBoxHandlers(
  props: Props,
  stage: React.RefObject<HTMLDivElement | null>,
  drag: React.RefObject<Gesture | null>,
  regionId: string,
  box: BBox,
  direction?: ResizeDirection,
): React.ButtonHTMLAttributes<HTMLButtonElement> {
  const update = (start: BBox, dx: number, dy: number) =>
    props.form.update(regionId, {
      sourceBbox: direction
        ? resizeBbox(start, direction, dx, dy)
        : moveBbox(start, dx, dy),
    });
  return {
    onPointerDown: (event) => {
      if (
        drag.current ||
        props.disabled ||
        props.tool !== "bounds" ||
        event.button !== 0
      )
        return;
      const focusedBefore = props.form.focused;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      props.form.beginGesture();
      event.currentTarget.setPointerCapture(event.pointerId);
      props.form.setFocused(regionId);
      drag.current = {
        pointerId: event.pointerId,
        clientStart: { x: event.clientX, y: event.clientY },
        moved: false,
        focusedBefore,
        start: regionReviewPosition(event, stage),
        regionId,
        box,
        direction,
      };
    },
    onPointerMove: (event) => {
      const active = drag.current;
      if (
        !active ||
        active.pointerId !== event.pointerId ||
        active.regionId !== regionId
      )
        return;
      active.moved ||= pointerMoved(active, event);
      if (!active.moved) return;
      const point = regionReviewPosition(event, stage);
      update(active.box, point.x - active.start.x, point.y - active.start.y);
    },
    onPointerUp: (event) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      const active = drag.current;
      if (active) active.moved ||= pointerMoved(active, event);
      props.form.endGesture();
      drag.current = null;
      if (active && !active.moved && !direction)
        selectOverlappingBox(props, stage, active);
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onLostPointerCapture: () => {
      if (drag.current) props.form.cancelGesture();
      drag.current = null;
    },
    onPointerCancel: () => {
      if (drag.current) props.form.cancelGesture();
      drag.current = null;
    },
    onKeyDown: (event) => handleBoxKey(event, props, drag, box, update),
    onKeyUp: (event) => {
      if (event.key.startsWith("Arrow")) props.form.endGesture();
    },
    onBlur: () => props.form.endGesture(),
  };
}

function selectOverlappingBox(
  props: Props,
  stage: React.RefObject<HTMLDivElement | null>,
  active: Gesture,
) {
  const point = active.start;
  const hits = props.form.values
    .filter(
      ({ sourceBbox: box }) =>
        point.x >= box.x &&
        point.x <= box.x + box.w &&
        point.y >= box.y &&
        point.y <= box.y + box.h,
    )
    .map((value) => value.regionId)
    .reverse();
  const at = hits.indexOf(active.regionId);
  const next =
    active.focusedBefore === active.regionId && at >= 0
      ? hits[(at + 1) % hits.length]
      : active.regionId;
  props.form.setFocused(next);
  requestAnimationFrame(() =>
    stage.current
      ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      ?.focus({ preventScroll: true }),
  );
}
function handleBoxKey(
  event: React.KeyboardEvent<HTMLButtonElement>,
  props: Props,
  drag: React.RefObject<Gesture | null>,
  box: BBox,
  update: (box: BBox, dx: number, dy: number) => void,
) {
  if (event.key === "Escape" && drag.current) {
    event.preventDefault();
    event.stopPropagation();
    props.form.cancelGesture();
    drag.current = null;
    return;
  }
  if (
    props.disabled ||
    props.tool !== "bounds" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return;
  const step = event.shiftKey ? 10 : 1;
  const delta = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }[event.key];
  if (delta) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) props.form.beginGesture();
    update(box, delta[0], delta[1]);
  }
}

function pointerMoved(
  active: Gesture,
  event: { clientX: number; clientY: number },
) {
  return (
    Math.hypot(
      event.clientX - active.clientStart.x,
      event.clientY - active.clientStart.y,
    ) >= 3
  );
}
