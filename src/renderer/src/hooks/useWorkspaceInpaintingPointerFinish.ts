import { useCallback, type MutableRefObject, type PointerEvent } from "react";
import {
  appendMaskStroke,
  constrainStrokeToLine,
  type ImagePoint,
} from "./workspaceInpaintingPointerState";
import type { ImagePointResolver } from "./useWorkspaceImagePointResolver";
import {
  commitWorkspaceRetouchShape,
  updateWorkspaceRetouchShape,
  type RetouchShapeDrawing,
} from "./workspaceRetouchShapeGesture";
import {
  finishRetouchStroke,
  replaceRetouchStrokePreview,
} from "../lib/retouchLiveOverlay";
import { releasePointerCaptureSafely } from "./workspacePointerCapture";
import type {
  BrushRadiusDrag,
  UseWorkspaceInpaintingPointerHandlersOptions,
} from "./workspaceInpaintingPointerTypes";

export function useInpaintingPointerUp(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: ImagePointResolver["resolve"],
  shapeDrawingRef: MutableRefObject<RetouchShapeDrawing | null>,
  brushRadiusDragRef: MutableRefObject<BrushRadiusDrag | null>,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (finishBrushRadiusDrag(options, event, brushRadiusDragRef))
        return true;
      if (!options.inpaintingRetouchDrawingRef.current) return false;
      finishRetouchDrawing(options, event, getImagePixelPoint, shapeDrawingRef);
      return true;
    },
    [brushRadiusDragRef, getImagePixelPoint, options, shapeDrawingRef],
  );
}

function finishBrushRadiusDrag(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  event: PointerEvent,
  dragRef: MutableRefObject<BrushRadiusDrag | null>,
): boolean {
  const drag = dragRef.current;
  if (!drag || event.pointerId !== drag.pointerId) return false;
  dragRef.current = null;
  releasePointerCaptureSafely(options.stageRef.current, event.pointerId);
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function finishRetouchDrawing(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  event: PointerEvent,
  getImagePixelPoint: ImagePointResolver["resolve"],
  shapeDrawingRef: MutableRefObject<RetouchShapeDrawing | null>,
): void {
  releasePointerCaptureSafely(options.stageRef.current, event.pointerId);
  options.inpaintingRetouchDrawingRef.current = false;
  const shapeDrawing = shapeDrawingRef.current;
  const shapeEnd = shapeDrawing ? getImagePixelPoint(event) : null;
  if (shapeDrawing && shapeEnd && options.stageRef.current) {
    updateWorkspaceRetouchShape(
      options.stageRef.current,
      shapeDrawing,
      shapeEnd,
    );
  }
  shapeDrawingRef.current = null;
  const points =
    !shapeDrawing && event.shiftKey
      ? finishStraightRetouchStroke(options, event, getImagePixelPoint)
      : options.inpaintingRetouchPointsRef.current;
  options.inpaintingRetouchPointsRef.current = [];
  options.lastInpaintingRetouchPointRef.current = null;
  if (shapeDrawing) {
    commitWorkspaceRetouchShape(options.applyRetouchOperation, shapeDrawing);
  } else {
    commitRetouchPoints(options, points);
  }
  finishRetouchStroke(options.stageRef.current);
}

function finishStraightRetouchStroke(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  event: PointerEvent,
  getImagePixelPoint: ImagePointResolver["resolve"],
): ImagePoint[] {
  const resolved = getImagePixelPoint(event);
  if (resolved) options.appendRetouchPoint(resolved.point);
  const points = constrainStrokeToLine(
    options.inpaintingRetouchPointsRef.current,
  );
  options.inpaintingRetouchPointsRef.current = points;
  if (resolved && options.stageRef.current) {
    replaceRetouchStrokePreview(
      options.stageRef.current,
      points,
      resolved.geometry,
    );
  }
  return points;
}

function commitRetouchPoints(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  points: ImagePoint[],
): void {
  if (
    options.inpaintingTool === "brush" ||
    options.inpaintingTool === "eraser"
  ) {
    void options.applyRetouchOperation({
      geometry: {
        kind: "stroke",
        points,
        radiusPx: options.inpaintingBrushRadius,
      },
      mode: options.inpaintingTool === "brush" ? "paint" : "restore",
    });
    return;
  }
  if (options.inpaintingTool !== "mask" || points.length === 0) return;
  appendPatternMaskStroke(options, points);
}

function appendPatternMaskStroke(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  points: ImagePoint[],
): void {
  const pageId = options.selectedPageIdRef.current;
  if (!pageId) return;
  const before = options.patternMaskStrokesByPage[pageId] ?? [];
  const next = appendMaskStroke(
    options.patternMaskStrokesByPage,
    pageId,
    points,
    options.inpaintingBrushRadius,
  );
  const after = next[pageId] ?? [];
  options.setPatternMaskStrokesByPage(next);
  options.onPatternMaskChange(pageId, before, after);
}
