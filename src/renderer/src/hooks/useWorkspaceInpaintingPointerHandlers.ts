import {
  useCallback,
  useRef,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  appendRetouchStrokePoint,
  clearRetouchLiveOverlay,
  hideRetouchCursor,
  queueRetouchCursor,
  replaceRetouchStrokePreview,
} from "../lib/retouchLiveOverlay";
import {
  constrainStrokeToLine,
  isRetouchDrawTool,
  isRetouchShapeTool,
  resolveDraggedBrushRadius,
} from "./workspaceInpaintingPointerState";
import {
  getCoalescedPointerSamples,
  useWorkspaceImagePointResolver,
  type ImagePointResolver,
} from "./useWorkspaceImagePointResolver";
import {
  updateWorkspaceRetouchShapeFromPointer,
  type RetouchShapeDrawing,
} from "./workspaceRetouchShapeGesture";
import { useInpaintingPointerDown } from "./useWorkspaceInpaintingPointerStart";
import { useInpaintingPointerUp } from "./useWorkspaceInpaintingPointerFinish";
import { releasePointerCaptureSafely } from "./workspacePointerCapture";
import type {
  BrushRadiusDrag,
  UseWorkspaceInpaintingPointerHandlersOptions,
} from "./workspaceInpaintingPointerTypes";

type InpaintingPointerHandlers = {
  cancelDrawing: () => boolean;
  onPointerDown: (event: PointerEvent) => boolean;
  onPointerLeave: () => void;
  onPointerMove: (event: PointerEvent) => boolean;
  onPointerUp: (event: PointerEvent) => boolean;
};

export function useWorkspaceInpaintingPointerHandlers(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
): InpaintingPointerHandlers {
  const { t } = useTranslation("renderer");
  const shapeDrawingRef = useRef<RetouchShapeDrawing | null>(null);
  const brushRadiusDragRef = useRef<BrushRadiusDrag | null>(null);
  const imagePointResolver = useWorkspaceImagePointResolver(options);
  const onPointerDown = useInpaintingPointerDown(
    options,
    imagePointResolver.resolve,
    shapeDrawingRef,
    brushRadiusDragRef,
    t,
  );
  const onPointerMove = useInpaintingPointerMove(
    options,
    imagePointResolver.resolve,
    shapeDrawingRef,
    brushRadiusDragRef,
  );
  const onPointerUp = useInpaintingPointerUp(
    options,
    imagePointResolver.resolve,
    shapeDrawingRef,
    brushRadiusDragRef,
  );
  const { inpaintingRetouchDrawingRef, stageRef } = options;
  const onPointerLeave = useCallback(() => {
    if (!inpaintingRetouchDrawingRef.current) {
      hideRetouchCursor(stageRef.current);
      imagePointResolver.invalidate();
    }
  }, [imagePointResolver, inpaintingRetouchDrawingRef, stageRef]);
  const cancelDrawing = useCancelRetouchDrawing(
    options,
    shapeDrawingRef,
    brushRadiusDragRef,
  );

  return {
    cancelDrawing,
    onPointerDown,
    onPointerLeave,
    onPointerMove,
    onPointerUp,
  };
}

function useCancelRetouchDrawing(
  {
    inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef,
    lastInpaintingRetouchPointRef,
    stageRef,
  }: UseWorkspaceInpaintingPointerHandlersOptions,
  shapeDrawingRef: MutableRefObject<RetouchShapeDrawing | null>,
  brushRadiusDragRef: MutableRefObject<BrushRadiusDrag | null>,
): () => boolean {
  return useCallback(() => {
    const radiusDrag = brushRadiusDragRef.current;
    const active = inpaintingRetouchDrawingRef.current || Boolean(radiusDrag);
    if (!active) return false;
    if (radiusDrag) {
      releasePointerCaptureSafely(stageRef.current, radiusDrag.pointerId);
    }
    inpaintingRetouchDrawingRef.current = false;
    inpaintingRetouchPointsRef.current = [];
    lastInpaintingRetouchPointRef.current = null;
    shapeDrawingRef.current = null;
    brushRadiusDragRef.current = null;
    clearRetouchLiveOverlay(stageRef.current);
    return true;
  }, [
    inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef,
    lastInpaintingRetouchPointRef,
    brushRadiusDragRef,
    shapeDrawingRef,
    stageRef,
  ]);
}

function useInpaintingPointerMove(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: ImagePointResolver["resolve"],
  shapeDrawingRef: MutableRefObject<RetouchShapeDrawing | null>,
  brushRadiusDragRef: MutableRefObject<BrushRadiusDrag | null>,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!options.inpaintingToolActive) return false;
      const radiusDrag = brushRadiusDragRef.current;
      if (radiusDrag)
        return handleBrushRadiusMove(
          options,
          getImagePixelPoint,
          event,
          radiusDrag,
        );
      if (isRetouchShapeTool(options.inpaintingTool)) {
        return updateWorkspaceRetouchShapeFromPointer(
          {
            jobActive: options.jobActive,
            shapeDrawingRef,
            stageRef: options.stageRef,
          },
          getImagePixelPoint,
          event,
        );
      }
      return handleRetouchDrawMove(options, getImagePixelPoint, event);
    },
    [brushRadiusDragRef, getImagePixelPoint, options, shapeDrawingRef],
  );
}

function handleBrushRadiusMove(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: ImagePointResolver["resolve"],
  event: PointerEvent,
  radiusDrag: BrushRadiusDrag,
): boolean {
  if (event.pointerId !== radiusDrag.pointerId) return true;
  event.preventDefault();
  event.stopPropagation();
  const nextRadius = resolveDraggedBrushRadius(
    radiusDrag.startRadius,
    event.clientX - radiusDrag.startClientX,
  );
  options.setInpaintingBrushRadius?.(nextRadius);
  const resolved = getImagePixelPoint(event);
  const stage = options.stageRef.current;
  if (resolved && stage) {
    queueRetouchCursor(stage, resolved.point, resolved.geometry, nextRadius);
  }
  return true;
}

function handleRetouchDrawMove(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: ImagePointResolver["resolve"],
  event: PointerEvent,
): boolean {
  if (!isRetouchDrawTool(options.inpaintingTool)) return true;
  if (options.jobActive) {
    hideRetouchCursor(options.stageRef.current);
    return true;
  }
  const stage = options.stageRef.current;
  if (!stage) return true;
  const samples = getCoalescedPointerSamples(event);
  if (options.inpaintingRetouchDrawingRef.current && event.shiftKey) {
    const sample = samples.at(-1);
    if (sample) {
      updateStraightRetouchStroke(options, getImagePixelPoint, stage, sample);
    }
    return true;
  }
  for (const sample of samples) {
    const resolved = getImagePixelPoint(sample);
    if (!resolved) continue;
    queueRetouchCursor(
      stage,
      resolved.point,
      resolved.geometry,
      options.inpaintingBrushRadius,
    );
    if (!options.inpaintingRetouchDrawingRef.current) continue;
    const appended = options.appendRetouchPoint(resolved.point);
    if (appended) appendRetouchStrokePoint(stage, appended, resolved.geometry);
  }
  return true;
}

function updateStraightRetouchStroke(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: ImagePointResolver["resolve"],
  stage: HTMLElement,
  sample: Pick<PointerEvent, "clientX" | "clientY">,
): void {
  const resolved = getImagePixelPoint(sample);
  if (!resolved) return;
  queueRetouchCursor(
    stage,
    resolved.point,
    resolved.geometry,
    options.inpaintingBrushRadius,
  );
  const appended = options.appendRetouchPoint(resolved.point);
  if (!appended) return;
  const points = constrainStrokeToLine(
    options.inpaintingRetouchPointsRef.current,
  );
  options.inpaintingRetouchPointsRef.current = points;
  replaceRetouchStrokePreview(stage, points, resolved.geometry);
}
