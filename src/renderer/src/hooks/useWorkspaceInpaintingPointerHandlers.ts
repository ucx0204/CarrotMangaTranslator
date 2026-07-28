import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  InpaintingMaskStroke,
  InpaintingRetouchGeometry,
} from "../../../shared/inpaintingTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import {
  appendRetouchStrokePoint,
  beginRetouchStroke,
  clearRetouchLiveOverlay,
  finishRetouchStroke,
  hideRetouchCursor,
  queueRetouchCursor,
} from "../lib/retouchLiveOverlay";
import { inpaintingGateway } from "../api/inpaintingGateway";
import {
  appendMaskStroke,
  isRetouchDrawTool,
  isRetouchShapeTool,
  type ImagePoint,
  type RetouchDrawTool,
} from "./workspaceInpaintingPointerState";
import {
  getCoalescedPointerSamples,
  useWorkspaceImagePointResolver,
  type ImagePointResolver,
  type ResolvedImagePoint,
} from "./useWorkspaceImagePointResolver";
import {
  commitWorkspaceRetouchShape,
  startWorkspaceRetouchShape,
  updateWorkspaceRetouchShape,
  updateWorkspaceRetouchShapeFromPointer,
  type RetouchShapeDrawing,
} from "./workspaceRetouchShapeGesture";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";

type UseWorkspaceInpaintingPointerHandlersOptions = {
  appendRetouchPoint: (point: ImagePoint) => ImagePoint | null;
  applyRetouchOperation: (operation: {
    geometry: InpaintingRetouchGeometry;
    mode: "paint" | "restore";
  }) => Promise<void>;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingBrushRadius: number;
  inpaintingPaintColor: string;
  inpaintingRetouchDrawingRef: MutableRefObject<boolean>;
  inpaintingRetouchPointsRef: MutableRefObject<ImagePoint[]>;
  inpaintingTool: InpaintingTool;
  inpaintingToolActive: boolean;
  jobActive: boolean;
  lastInpaintingRetouchPointRef: MutableRefObject<ImagePoint | null>;
  onPatternMaskChange: (
    pageId: string,
    before: InpaintingMaskStroke[],
    after: InpaintingMaskStroke[],
  ) => void;
  patternMaskStrokesByPage: Record<string, InpaintingMaskStroke[]>;
  pushStatus: (line: string) => void;
  selectedPage: MangaPage | null;
  selectedPageIdRef: MutableRefObject<string | null>;
  selectedPageImagePath: string | null;
  setInpaintingPaintColor: Dispatch<SetStateAction<string>>;
  setPatternMaskStrokesByPage: Dispatch<
    SetStateAction<Record<string, InpaintingMaskStroke[]>>
  >;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  stageRef: RefObject<HTMLDivElement | null>;
};

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
  const imagePointResolver = useWorkspaceImagePointResolver(options);
  const onPointerDown = useInpaintingPointerDown(
    options,
    imagePointResolver.resolve,
    shapeDrawingRef,
    t,
  );
  const onPointerMove = useInpaintingPointerMove(
    options,
    imagePointResolver.resolve,
    shapeDrawingRef,
  );
  const onPointerUp = useInpaintingPointerUp(
    options,
    imagePointResolver.resolve,
    shapeDrawingRef,
  );
  const { inpaintingRetouchDrawingRef, stageRef } = options;
  const onPointerLeave = useCallback(() => {
    if (!inpaintingRetouchDrawingRef.current) {
      hideRetouchCursor(stageRef.current);
      imagePointResolver.invalidate();
    }
  }, [imagePointResolver, inpaintingRetouchDrawingRef, stageRef]);
  const cancelDrawing = useCancelRetouchDrawing(options, shapeDrawingRef);

  return {
    cancelDrawing,
    onPointerDown,
    onPointerLeave,
    onPointerMove,
    onPointerUp,
  };
}

function useInpaintingPointerDown(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: ImagePointResolver["resolve"],
  shapeDrawingRef: MutableRefObject<RetouchShapeDrawing | null>,
  t: TFunction<"renderer">,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!options.inpaintingToolActive || options.jobActive) {
        return false;
      }
      const resolved = getImagePixelPoint(event, true);
      if (!resolved || !options.stageRef.current) {
        return true;
      }
      if (isRetouchDrawTool(options.inpaintingTool)) {
        queueRetouchCursor(
          options.stageRef.current,
          resolved.point,
          resolved.geometry,
          options.inpaintingBrushRadius,
        );
      }
      event.preventDefault();
      event.stopPropagation();
      options.setSelectedBlockId(null);
      if (options.inpaintingTool === "picker") {
        sampleInpaintingColor(options, resolved.point, t);
      } else if (isRetouchDrawTool(options.inpaintingTool)) {
        startRetouchDrawing(options, resolved, event, options.inpaintingTool);
      } else if (isRetouchShapeTool(options.inpaintingTool)) {
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
      return true;
    },
    [getImagePixelPoint, options, shapeDrawingRef, t],
  );
}

function useCancelRetouchDrawing(
  {
    inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef,
    lastInpaintingRetouchPointRef,
    stageRef,
  }: UseWorkspaceInpaintingPointerHandlersOptions,
  shapeDrawingRef: MutableRefObject<RetouchShapeDrawing | null>,
): () => boolean {
  return useCallback(() => {
    if (!inpaintingRetouchDrawingRef.current) return false;
    inpaintingRetouchDrawingRef.current = false;
    inpaintingRetouchPointsRef.current = [];
    lastInpaintingRetouchPointRef.current = null;
    shapeDrawingRef.current = null;
    clearRetouchLiveOverlay(stageRef.current);
    return true;
  }, [
    inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef,
    lastInpaintingRetouchPointRef,
    shapeDrawingRef,
    stageRef,
  ]);
}

function useInpaintingPointerMove(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: ImagePointResolver["resolve"],
  shapeDrawingRef: MutableRefObject<RetouchShapeDrawing | null>,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!options.inpaintingToolActive) {
        return false;
      }
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
      if (!isRetouchDrawTool(options.inpaintingTool)) {
        return true;
      }
      if (options.jobActive) {
        hideRetouchCursor(options.stageRef.current);
        return true;
      }
      const stage = options.stageRef.current;
      if (!stage) return true;
      for (const sample of getCoalescedPointerSamples(event)) {
        const resolved = getImagePixelPoint(sample);
        if (!resolved) continue;
        queueRetouchCursor(
          stage,
          resolved.point,
          resolved.geometry,
          options.inpaintingBrushRadius,
        );
        if (options.inpaintingRetouchDrawingRef.current) {
          const appended = options.appendRetouchPoint(resolved.point);
          if (appended) {
            appendRetouchStrokePoint(stage, appended, resolved.geometry);
          }
        }
      }
      return true;
    },
    [getImagePixelPoint, options, shapeDrawingRef],
  );
}

function useInpaintingPointerUp(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: ImagePointResolver["resolve"],
  shapeDrawingRef: MutableRefObject<RetouchShapeDrawing | null>,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!options.inpaintingRetouchDrawingRef.current) {
        return false;
      }
      releasePointerCaptureSafely(options.stageRef.current, event.pointerId);
      options.inpaintingRetouchDrawingRef.current = false;
      options.lastInpaintingRetouchPointRef.current = null;
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
      const points = options.inpaintingRetouchPointsRef.current;
      options.inpaintingRetouchPointsRef.current = [];
      if (shapeDrawing) {
        commitWorkspaceRetouchShape(
          options.applyRetouchOperation,
          shapeDrawing,
        );
      } else {
        commitRetouchPoints(options, points);
      }
      finishRetouchStroke(options.stageRef.current);
      return true;
    },
    [getImagePixelPoint, options, shapeDrawingRef],
  );
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
  if (!imagePath) {
    return;
  }
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
  {
    appendRetouchPoint,
    inpaintingBrushRadius,
    inpaintingPaintColor,
    inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef,
    lastInpaintingRetouchPointRef,
    stageRef,
  }: UseWorkspaceInpaintingPointerHandlersOptions,
  resolved: ResolvedImagePoint,
  event: PointerEvent,
  tool: RetouchDrawTool,
): void {
  inpaintingRetouchDrawingRef.current = true;
  inpaintingRetouchPointsRef.current = [];
  lastInpaintingRetouchPointRef.current = null;
  const point = appendRetouchPoint(resolved.point);
  if (point && stageRef.current) {
    beginRetouchStroke(stageRef.current, point, resolved.geometry, {
      color: inpaintingPaintColor,
      mode: tool,
      radiusPx: inpaintingBrushRadius,
    });
  }
  capturePointerSafely(stageRef.current, event.pointerId);
}

function commitRetouchPoints(
  {
    applyRetouchOperation,
    inpaintingBrushRadius,
    inpaintingTool,
    onPatternMaskChange,
    patternMaskStrokesByPage,
    selectedPageIdRef,
    setPatternMaskStrokesByPage,
  }: UseWorkspaceInpaintingPointerHandlersOptions,
  points: ImagePoint[],
): void {
  if (inpaintingTool === "brush" || inpaintingTool === "eraser") {
    void applyRetouchOperation({
      geometry: {
        kind: "stroke",
        points,
        radiusPx: inpaintingBrushRadius,
      },
      mode: inpaintingTool === "brush" ? "paint" : "restore",
    });
  } else if (inpaintingTool === "mask" && points.length > 0) {
    const pageId = selectedPageIdRef.current;
    if (pageId) {
      const before = patternMaskStrokesByPage[pageId] ?? [];
      const next = appendMaskStroke(
        patternMaskStrokesByPage,
        pageId,
        points,
        inpaintingBrushRadius,
      );
      const after = next[pageId] ?? [];
      setPatternMaskStrokesByPage(next);
      onPatternMaskChange(pageId, before, after);
    }
  }
}
