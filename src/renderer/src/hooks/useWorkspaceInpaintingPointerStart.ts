import { useCallback, type MutableRefObject, type PointerEvent } from "react";
import type { TFunction } from "i18next";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import { inpaintingGateway } from "../api/inpaintingGateway";
import {
  beginRetouchStroke,
  queueRetouchCursor,
} from "../lib/retouchLiveOverlay";
import {
  isRetouchDrawTool,
  isRetouchShapeTool,
  type ImagePoint,
  type RetouchDrawTool,
} from "./workspaceInpaintingPointerState";
import type {
  ImagePointResolver,
  ResolvedImagePoint,
} from "./useWorkspaceImagePointResolver";
import {
  startWorkspaceRetouchShape,
  type RetouchShapeDrawing,
} from "./workspaceRetouchShapeGesture";
import { capturePointerSafely } from "./workspacePointerCapture";
import type {
  BrushRadiusDrag,
  UseWorkspaceInpaintingPointerHandlersOptions,
} from "./workspaceInpaintingPointerTypes";

export function useInpaintingPointerDown(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: ImagePointResolver["resolve"],
  shapeDrawingRef: MutableRefObject<RetouchShapeDrawing | null>,
  brushRadiusDragRef: MutableRefObject<BrushRadiusDrag | null>,
  t: TFunction<"renderer">,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!options.inpaintingToolActive || options.jobActive) return false;
      if (startBrushRadiusDrag(options, event, brushRadiusDragRef)) return true;
      const resolved = getImagePixelPoint(event, true);
      if (!resolved || !options.stageRef.current) return true;
      queueDrawToolCursor(options, resolved);
      event.preventDefault();
      event.stopPropagation();
      options.setSelectedBlockId(null);
      handleToolPointerDown(options, resolved, event, shapeDrawingRef, t);
      return true;
    },
    [brushRadiusDragRef, getImagePixelPoint, options, shapeDrawingRef, t],
  );
}

function startBrushRadiusDrag(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  event: PointerEvent,
  dragRef: MutableRefObject<BrushRadiusDrag | null>,
): boolean {
  if (
    !event.altKey ||
    event.button !== 2 ||
    !isRetouchDrawTool(options.inpaintingTool)
  ) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  dragRef.current = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startRadius: options.inpaintingBrushRadius,
  };
  capturePointerSafely(options.stageRef.current, event.pointerId);
  return true;
}

function queueDrawToolCursor(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  resolved: ResolvedImagePoint,
): void {
  const stage = options.stageRef.current;
  if (!isRetouchDrawTool(options.inpaintingTool) || !stage) return;
  queueRetouchCursor(
    stage,
    resolved.point,
    resolved.geometry,
    options.inpaintingBrushRadius,
  );
}

function handleToolPointerDown(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  resolved: ResolvedImagePoint,
  event: PointerEvent,
  shapeDrawingRef: MutableRefObject<RetouchShapeDrawing | null>,
  t: TFunction<"renderer">,
): void {
  if (event.button !== 0) return;
  if (isAlternateColorSample(options.inpaintingTool, event.altKey)) {
    sampleInpaintingColor(options, resolved.point, t);
    return;
  }
  if (options.inpaintingTool === "picker") {
    sampleInpaintingColor(options, resolved.point, t);
    return;
  }
  if (isRetouchDrawTool(options.inpaintingTool)) {
    startRetouchDrawing(options, resolved, event, options.inpaintingTool);
    return;
  }
  if (isRetouchShapeTool(options.inpaintingTool)) {
    startWorkspaceRetouchShape(
      {
        color: options.inpaintingPaintColor,
        drawingRef: options.inpaintingRetouchDrawingRef,
        lastPointRef: options.lastInpaintingRetouchPointRef,
        pointsRef: options.inpaintingRetouchPointsRef,
        shapeDrawingRef,
        stageRef: options.stageRef,
      },
      resolved,
      event,
      options.inpaintingTool,
    );
  }
}

function isAlternateColorSample(
  tool: InpaintingTool,
  altKey: boolean,
): boolean {
  return altKey && ["brush", "rectangle", "ellipse"].includes(tool);
}

function sampleInpaintingColor(
  {
    pushStatus,
    selectedPage,
    selectedPageImagePath,
    setInpaintingPaintColor,
  }: UseWorkspaceInpaintingPointerHandlersOptions,
  point: ImagePoint,
  t: TFunction<"renderer">,
): void {
  const imagePath = selectedPageImagePath ?? selectedPage?.imagePath;
  if (!imagePath) return;
  void inpaintingGateway
    .sampleInpaintingColor({ imagePath, x: point.x, y: point.y })
    .then((result) => {
      setInpaintingPaintColor(result.color);
      pushStatus(t("inpainting.color.selected", { color: result.color }));
    })
    .catch((error) => {
      console.error(error);
      pushStatus(t("inpainting.color.sampleFailed"));
    });
}

function startRetouchDrawing(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  resolved: ResolvedImagePoint,
  event: PointerEvent,
  tool: RetouchDrawTool,
): void {
  options.inpaintingRetouchDrawingRef.current = true;
  options.inpaintingRetouchPointsRef.current = [];
  options.lastInpaintingRetouchPointRef.current = null;
  const point = options.appendRetouchPoint(resolved.point);
  if (point && options.stageRef.current) {
    beginRetouchStroke(options.stageRef.current, point, resolved.geometry, {
      color: options.inpaintingPaintColor,
      mode: tool,
      radiusPx: options.inpaintingBrushRadius,
    });
  }
  capturePointerSafely(options.stageRef.current, event.pointerId);
}
