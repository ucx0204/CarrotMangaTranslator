import React from "react";
import type { ImageRedactionStroke } from "../../../../shared/imageRedaction";
import type {
  RedactionPreferences,
  RedactionWorkspacePage,
} from "../../../../shared/imageRedactionWorkspace";
import {
  hitRedactionStroke,
  moveRedactionStroke,
  redactionStrokeBounds,
  resizeRedactionRectangle,
} from "../../../../shared/imageRedactionEditing";

type Point = { x: number; y: number };
type Gesture =
  | {
      kind: "draw";
      pointer: number;
      pageId: string;
      stroke: ImageRedactionStroke;
    }
  | {
      kind: "move" | "resize";
      pointer: number;
      pageId: string;
      start: Point;
      index: number;
      original: ImageRedactionStroke;
    }
  | {
      kind: "pan";
      pointer: number;
      pageId: string;
      start: Point;
      left: number;
      top: number;
    };
type Options = {
  page: RedactionWorkspacePage;
  strokes: ImageRedactionStroke[];
  preferences: RedactionPreferences;
  viewport: React.RefObject<HTMLDivElement | null>;
  disabled: boolean;
  spaceHeld: boolean;
  selected: number;
  setSelected: (index: number) => void;
  onChange: (strokes: ImageRedactionStroke[]) => void;
  onDrawing: (drawing: boolean) => void;
};

export function useRedactionGestures(options: Options) {
  const gesture = React.useRef<Gesture | null>(null);
  const [draft, setDraft] = React.useState<ImageRedactionStroke | null>(null);
  const [transformed, setTransformed] = React.useState<
    ImageRedactionStroke[] | null
  >(null);
  const { pendingFrame, frame } = useGestureFrame();
  const clear = () => {
    if (pendingFrame.current !== null)
      cancelAnimationFrame(pendingFrame.current);
    pendingFrame.current = null;
    gesture.current = null;
    setDraft(null);
    setTransformed(null);
    options.onDrawing(false);
  };
  return {
    draft,
    transformed,
    handlers: {
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) =>
        beginGesture(event, options, gesture, setDraft),
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
        const current = gesture.current;
        if (
          !current ||
          current.pointer !== event.pointerId ||
          current.pageId !== options.page.id
        )
          return;
        if (current.kind === "pan") {
          moveViewport(event, current, options.viewport.current);
          return;
        }
        const point = imagePoint(event, options.page);
        if (current.kind === "draw") {
          current.stroke = extendStroke(current.stroke, point);
          frame(() => setDraft(current.stroke));
        } else
          frame(() =>
            setTransformed(transformStrokes(options, current, point)),
          );
      },
      onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
        const current = gesture.current;
        if (!current || current.pointer !== event.pointerId) return;
        if (current.pageId === options.page.id && current.kind !== "pan") {
          const point = imagePoint(event, options.page);
          if (current.kind === "draw") {
            const stroke = extendStroke(current.stroke, point);
            const bounds = redactionStrokeBounds(stroke);
            if (bounds.width > 0 && bounds.height > 0)
              options.onChange([...options.strokes, stroke]);
          } else options.onChange(transformStrokes(options, current, point));
        }
        clear();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      },
      onPointerCancel: clear,
      onLostPointerCapture: () => {
        if (gesture.current) clear();
      },
    },
  };
}

function imagePoint(
  event: React.PointerEvent<HTMLDivElement>,
  page: RedactionWorkspacePage,
): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(
        page.width,
        ((event.clientX - rect.left) * page.width) / Math.max(1, rect.width),
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        page.height,
        ((event.clientY - rect.top) * page.height) / Math.max(1, rect.height),
      ),
    ),
  };
}
function extendStroke(
  stroke: ImageRedactionStroke,
  point: Point,
): ImageRedactionStroke {
  if (stroke.shape === "rectangle")
    return { ...stroke, points: [stroke.points[0], point] };
  return { ...stroke, points: [...stroke.points.slice(0, 19999), point] };
}
function beginGesture(
  event: React.PointerEvent<HTMLDivElement>,
  options: Options,
  ref: React.MutableRefObject<Gesture | null>,
  setDraft: (stroke: ImageRedactionStroke) => void,
): void {
  if (
    options.disabled ||
    ref.current ||
    event.button > 1 ||
    (event.button === 1 && (event.ctrlKey || event.metaKey))
  )
    return;
  event.preventDefault();
  event.currentTarget.focus();
  const gesture = createGesture(event, options);
  if (!gesture) return;
  ref.current = gesture;
  if (gesture.kind === "draw") setDraft(gesture.stroke);
  options.onDrawing(true);
  event.currentTarget.setPointerCapture(event.pointerId);
}
function createGesture(
  event: React.PointerEvent<HTMLDivElement>,
  options: Options,
): Gesture | null {
  const base = { pointer: event.pointerId, pageId: options.page.id };
  if (usesPanTool(options, event.button))
    return {
      ...base,
      kind: "pan",
      start: { x: event.clientX, y: event.clientY },
      left: options.viewport.current?.scrollLeft ?? 0,
      top: options.viewport.current?.scrollTop ?? 0,
    };
  if (options.preferences.tool === "select") {
    const selected = selectionGesture(event, options);
    return selected ? { ...base, ...selected } : null;
  }
  if (options.strokes.length >= 1000) return null;
  return {
    ...base,
    kind: "draw",
    stroke: {
      shape:
        options.preferences.tool === "rectangle"
          ? "rectangle"
          : options.preferences.shape,
      operation: options.preferences.tool === "erase" ? "restore" : "hide",
      size: options.preferences.size,
      points: [imagePoint(event, options.page)],
    },
  };
}
function selectionGesture(
  event: React.PointerEvent<HTMLDivElement>,
  options: Options,
) {
  const point = imagePoint(event, options.page);
  const selected = options.strokes[options.selected];
  if (selected?.shape === "rectangle") {
    const bounds = redactionStrokeBounds(selected);
    const tolerance =
      (12 * options.page.width) /
      Math.max(1, event.currentTarget.getBoundingClientRect().width);
    if (
      Math.hypot(
        point.x - bounds.x - bounds.width,
        point.y - bounds.y - bounds.height,
      ) <= tolerance
    )
      return {
        kind: "resize" as const,
        start: point,
        index: options.selected,
        original: selected,
      };
  }
  const index = hitRedactionStroke(options.strokes, point);
  options.setSelected(index);
  return index < 0
    ? null
    : {
        kind: "move" as const,
        start: point,
        index,
        original: options.strokes[index],
      };
}
function transformStrokes(
  options: Options,
  gesture: Extract<Gesture, { kind: "move" | "resize" }>,
  point: Point,
): ImageRedactionStroke[] {
  const stroke =
    gesture.kind === "resize"
      ? resizeRedactionRectangle(gesture.original, point, options.page)
      : moveRedactionStroke(
          gesture.original,
          point.x - gesture.start.x,
          point.y - gesture.start.y,
          options.page,
        );
  return options.strokes.map((current, index) =>
    index === gesture.index ? stroke : current,
  );
}
function moveViewport(
  event: React.PointerEvent<HTMLDivElement>,
  gesture: Extract<Gesture, { kind: "pan" }>,
  viewport: HTMLDivElement | null,
): void {
  if (!viewport) return;
  viewport.scrollLeft = gesture.left + gesture.start.x - event.clientX;
  viewport.scrollTop = gesture.top + gesture.start.y - event.clientY;
}

function useGestureFrame() {
  const pendingFrame = React.useRef<number | null>(null);
  const frame = (update: () => void) => {
    if (pendingFrame.current !== null)
      cancelAnimationFrame(pendingFrame.current);
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = null;
      update();
    });
  };
  React.useEffect(
    () => () => {
      if (pendingFrame.current !== null)
        cancelAnimationFrame(pendingFrame.current);
    },
    [],
  );
  return { pendingFrame, frame };
}

function usesPanTool(options: Options, button: number): boolean {
  return (
    options.preferences.tool === "pan" || options.spaceHeld || button === 1
  );
}
