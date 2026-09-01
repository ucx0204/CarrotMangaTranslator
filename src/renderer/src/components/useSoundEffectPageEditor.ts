import React from "react";
import type { BBox } from "../../../shared/textTypes";
import {
  moveBbox,
  normalizeDrawnBbox,
  resizeBbox,
  resolvePagePoint,
  type ResizeDirection,
} from "./soundEffectTranslationDraftModel";

type Point = { x: number; y: number };
type ExistingRegionOperation = {
  mode: "move" | "resize";
  pointerId: number;
  regionId: string;
  start: Point;
  original: BBox;
  direction?: ResizeDirection;
  moved: boolean;
};
type PointerOperation =
  | ExistingRegionOperation
  | {
      mode: "create";
      pointerId: number;
      start: Point;
      current: Point;
      moved: boolean;
    };

export function useSoundEffectPageEditor({
  stageRef,
  visualSize,
  onCreateRegion,
  onUpdateRegion,
}: {
  stageRef: React.RefObject<HTMLDivElement | null>;
  visualSize: { width: number; height: number };
  onCreateRegion: (bbox: BBox) => void;
  onUpdateRegion: (regionId: string, bbox: BBox) => void;
}) {
  const operationRef = React.useRef<PointerOperation | null>(null);
  const suppressClickRef = React.useRef(false);
  const [creationBbox, setCreationBbox] = React.useState<BBox | null>(null);
  usePointerOperationLifecycle({
    operationRef,
    stageRef,
    visualSize,
    onCreateRegion,
    onUpdateRegion,
    setCreationBbox,
    suppressClickRef,
  });
  const point = React.useCallback(
    (event: Pick<PointerEvent, "clientX" | "clientY">) =>
      resolvePagePoint(stageRef.current, event, visualSize),
    [stageRef, visualSize],
  );
  return {
    creationBbox,
    suppressClickRef,
    beginCreate: (event: React.PointerEvent) => {
      const start = point(event.nativeEvent);
      operationRef.current = {
        mode: "create",
        pointerId: event.pointerId,
        start,
        current: start,
        moved: false,
      };
    },
    beginMove: (event: React.PointerEvent, regionId: string, bbox: BBox) => {
      operationRef.current = existingOperation(
        "move",
        event,
        regionId,
        bbox,
        point,
      );
    },
    beginResize: (
      event: React.PointerEvent,
      regionId: string,
      bbox: BBox,
      direction: ResizeDirection,
    ) => {
      operationRef.current = {
        ...existingOperation("resize", event, regionId, bbox, point),
        direction,
      };
    },
  };
}

function usePointerOperationLifecycle({
  operationRef,
  stageRef,
  visualSize,
  onCreateRegion,
  onUpdateRegion,
  setCreationBbox,
  suppressClickRef,
}: {
  operationRef: React.RefObject<PointerOperation | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  visualSize: { width: number; height: number };
  onCreateRegion: (bbox: BBox) => void;
  onUpdateRegion: (regionId: string, bbox: BBox) => void;
  setCreationBbox: (bbox: BBox | null) => void;
  suppressClickRef: React.RefObject<boolean>;
}): void {
  React.useEffect(() => {
    const handleMove = (event: PointerEvent): void => {
      const operation = operationRef.current;
      if (!operation || event.pointerId !== operation.pointerId) return;
      const point = resolvePagePoint(stageRef.current, event, visualSize);
      const dx = point.x - operation.start.x;
      const dy = point.y - operation.start.y;
      if (Math.hypot(dx, dy) >= 2) operation.moved = true;
      if (operation.mode === "create") {
        operation.current = point;
        setCreationBbox(normalizeDrawnBbox(operation.start, point));
        return;
      }
      const bbox =
        operation.mode === "move"
          ? moveBbox(operation.original, dx, dy)
          : resizeBbox(operation.original, operation.direction ?? "se", dx, dy);
      onUpdateRegion(operation.regionId, bbox);
    };
    const handleUp = (event: PointerEvent): void => {
      const operation = operationRef.current;
      if (!operation || event.pointerId !== operation.pointerId) return;
      // A move ends with a synthetic click on the candidate button, while a
      // resize ends on its handle (whose click is already stopped). Suppress
      // only the former so the next intentional candidate click is never lost.
      suppressClickRef.current = operation.mode === "move" && operation.moved;
      if (operation.mode === "create") {
        const bbox = normalizeDrawnBbox(operation.start, operation.current);
        if (bbox.w >= 4 && bbox.h >= 4) onCreateRegion(bbox);
      }
      setCreationBbox(null);
      operationRef.current = null;
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [
    onCreateRegion,
    onUpdateRegion,
    operationRef,
    setCreationBbox,
    stageRef,
    suppressClickRef,
    visualSize,
  ]);
}

function existingOperation(
  mode: "move" | "resize",
  event: React.PointerEvent,
  regionId: string,
  bbox: BBox,
  point: (event: Pick<PointerEvent, "clientX" | "clientY">) => Point,
): ExistingRegionOperation {
  return {
    mode,
    pointerId: event.pointerId,
    regionId,
    start: point(event.nativeEvent),
    original: bbox,
    moved: false,
  };
}
