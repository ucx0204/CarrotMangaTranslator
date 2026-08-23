import type { MutableRefObject, PointerEvent, RefObject } from "react";
import type { InpaintingRetouchGeometry } from "../../../shared/inpaintingTypes";
import {
  beginRetouchShape,
  updateRetouchShape,
} from "../lib/retouchLiveOverlay";
import type {
  ImagePointResolver,
  ResolvedImagePoint,
} from "./useWorkspaceImagePointResolver";
import { capturePointerSafely } from "./workspacePointerCapture";
import type {
  ImagePoint,
  RetouchShapeTool,
} from "./workspaceInpaintingPointerState";

export type RetouchShapeDrawing = {
  end: ImagePoint;
  kind: "rectangle" | "ellipse";
  mode: "paint" | "restore";
  start: ImagePoint;
};

export function startWorkspaceRetouchShape(
  options: {
    color: string;
    drawingRef: MutableRefObject<boolean>;
    lastPointRef: MutableRefObject<ImagePoint | null>;
    pointsRef: MutableRefObject<ImagePoint[]>;
    shapeDrawingRef: MutableRefObject<RetouchShapeDrawing | null>;
    stageRef: RefObject<HTMLDivElement | null>;
  },
  resolved: ResolvedImagePoint,
  event: PointerEvent,
  kind: RetouchShapeTool,
): void {
  options.drawingRef.current = true;
  options.pointsRef.current = [];
  options.lastPointRef.current = null;
  const shape = resolveRetouchShape(kind);
  options.shapeDrawingRef.current = {
    end: resolved.point,
    ...shape,
    start: resolved.point,
  };
  if (options.stageRef.current) {
    beginRetouchShape(
      options.stageRef.current,
      resolved.point,
      resolved.geometry,
      { color: options.color, ...shape },
    );
  }
  capturePointerSafely(options.stageRef.current, event.pointerId);
}

export function updateWorkspaceRetouchShapeFromPointer(
  options: {
    jobActive: boolean;
    shapeDrawingRef: MutableRefObject<RetouchShapeDrawing | null>;
    stageRef: RefObject<HTMLDivElement | null>;
  },
  getImagePixelPoint: ImagePointResolver["resolve"],
  event: PointerEvent,
): boolean {
  if (options.jobActive) return true;
  const stage = options.stageRef.current;
  const drawing = options.shapeDrawingRef.current;
  if (!stage || !drawing) return true;
  const resolved = getImagePixelPoint(event);
  if (resolved) updateWorkspaceRetouchShape(stage, drawing, resolved);
  return true;
}

export function updateWorkspaceRetouchShape(
  stage: HTMLElement,
  drawing: RetouchShapeDrawing,
  resolved: ResolvedImagePoint,
): void {
  drawing.end = resolved.point;
  updateRetouchShape(stage, resolved.point, resolved.geometry);
}

export function commitWorkspaceRetouchShape(
  applyRetouchOperation: (operation: {
    geometry: InpaintingRetouchGeometry;
    mode: "paint" | "restore";
  }) => Promise<void>,
  drawing: RetouchShapeDrawing,
): void {
  void applyRetouchOperation({
    geometry: {
      kind: drawing.kind,
      start: drawing.start,
      end: drawing.end,
    },
    mode: drawing.mode,
  });
}

function resolveRetouchShape(kind: RetouchShapeTool): {
  kind: "rectangle" | "ellipse";
  mode: "paint" | "restore";
} {
  return kind === "eraser-rectangle"
    ? { kind: "rectangle", mode: "restore" }
    : { kind, mode: "paint" };
}
