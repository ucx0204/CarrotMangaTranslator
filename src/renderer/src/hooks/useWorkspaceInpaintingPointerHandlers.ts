import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { InpaintingMaskStroke } from "../../../shared/inpaintingTypes";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import type { MangaPage } from "./hookLibraryTypes";
import { libraryGateway } from "./libraryGateway";
import type { RetouchPreviewState } from "./useInpaintingRetouch";
import {
  appendMaskStroke,
  isRetouchDrawTool,
  resolveImagePixelPoint,
  type ImagePoint,
  type RetouchDrawTool,
} from "./workspaceInpaintingPointerState";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";

type UseWorkspaceInpaintingPointerHandlersOptions = {
  appendRetouchPoint: (
    point: ImagePoint,
    tool?: "brush" | "eraser" | "mask",
  ) => void;
  applyRetouchPoints: (
    tool: "brush" | "eraser",
    points: ImagePoint[],
  ) => Promise<void>;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingBrushRadius: number;
  inpaintingRetouchDrawingRef: MutableRefObject<boolean>;
  inpaintingRetouchPointsRef: MutableRefObject<ImagePoint[]>;
  inpaintingTool: InpaintingTool;
  inpaintingToolActive: boolean;
  lastInpaintingRetouchPointRef: MutableRefObject<ImagePoint | null>;
  pushStatus: (line: string) => void;
  selectedPage: MangaPage | null;
  selectedPageIdRef: MutableRefObject<string | null>;
  selectedPageImagePath: string | null;
  setInpaintingPaintColor: Dispatch<SetStateAction<string>>;
  setPatternMaskStrokesByPage: Dispatch<
    SetStateAction<Record<string, InpaintingMaskStroke[]>>
  >;
  setRetouchCursorPoint: Dispatch<SetStateAction<ImagePoint | null>>;
  setRetouchPreview: Dispatch<SetStateAction<RetouchPreviewState | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  stageRef: RefObject<HTMLDivElement | null>;
};

type InpaintingPointerHandlers = {
  onPointerDown: (event: PointerEvent) => boolean;
  onPointerLeave: () => void;
  onPointerMove: (event: PointerEvent) => boolean;
  onPointerUp: (event: PointerEvent) => boolean;
};

export function useWorkspaceInpaintingPointerHandlers(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
): InpaintingPointerHandlers {
  const getImagePixelPoint = useImagePixelPoint(options);
  const onPointerDown = useInpaintingPointerDown(options, getImagePixelPoint);
  const onPointerMove = useInpaintingPointerMove(options, getImagePixelPoint);
  const onPointerUp = useInpaintingPointerUp(options);
  const { inpaintingRetouchDrawingRef, setRetouchCursorPoint } = options;
  const onPointerLeave = useCallback(() => {
    if (!inpaintingRetouchDrawingRef.current) {
      setRetouchCursorPoint(null);
    }
  }, [inpaintingRetouchDrawingRef, setRetouchCursorPoint]);

  return {
    onPointerDown,
    onPointerLeave,
    onPointerMove,
    onPointerUp,
  };
}

function useImagePixelPoint({
  imageRef,
  selectedPage,
  stageRef,
}: UseWorkspaceInpaintingPointerHandlersOptions): (
  event: PointerEvent,
) => ImagePoint | null {
  return useCallback(
    (event) => {
      const stage = stageRef.current;
      const page = selectedPage;
      if (!stage || !page) {
        return null;
      }
      const rect =
        imageRef.current?.getBoundingClientRect() ??
        stage.getBoundingClientRect();
      return resolveImagePixelPoint(event, rect, page);
    },
    [imageRef, selectedPage, stageRef],
  );
}

function useInpaintingPointerDown(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: (event: PointerEvent) => ImagePoint | null,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!options.inpaintingToolActive) {
        return false;
      }
      const point = getImagePixelPoint(event);
      if (!point || !options.stageRef.current) {
        return true;
      }
      if (isRetouchDrawTool(options.inpaintingTool)) {
        options.setRetouchCursorPoint(point);
      }
      event.preventDefault();
      event.stopPropagation();
      options.setSelectedBlockId(null);
      if (options.inpaintingTool === "picker") {
        sampleInpaintingColor(options, point);
      } else if (isRetouchDrawTool(options.inpaintingTool)) {
        startRetouchDrawing(options, point, event, options.inpaintingTool);
      }
      return true;
    },
    [getImagePixelPoint, options],
  );
}

function useInpaintingPointerMove(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: (event: PointerEvent) => ImagePoint | null,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!options.inpaintingToolActive) {
        return false;
      }
      const point = getImagePixelPoint(event);
      if (point && isRetouchDrawTool(options.inpaintingTool)) {
        options.setRetouchCursorPoint(point);
      }
      if (
        point &&
        options.inpaintingRetouchDrawingRef.current &&
        isRetouchDrawTool(options.inpaintingTool)
      ) {
        options.appendRetouchPoint(point, options.inpaintingTool);
      }
      return true;
    },
    [getImagePixelPoint, options],
  );
}

function useInpaintingPointerUp(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!options.inpaintingRetouchDrawingRef.current) {
        return false;
      }
      releasePointerCaptureSafely(options.stageRef.current, event.pointerId);
      options.inpaintingRetouchDrawingRef.current = false;
      options.lastInpaintingRetouchPointRef.current = null;
      const points = options.inpaintingRetouchPointsRef.current;
      options.inpaintingRetouchPointsRef.current = [];
      commitRetouchPoints(options, points);
      window.setTimeout(() => options.setRetouchPreview(null), 180);
      return true;
    },
    [options],
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
): void {
  const imagePath = selectedPageImagePath ?? selectedPage?.imagePath;
  if (!imagePath) {
    return;
  }
  void libraryGateway
    .sampleInpaintingColor({ imagePath, x: point.x, y: point.y })
    .then((result) => {
      setInpaintingPaintColor(result.color);
      pushStatus(
        `붓 색상을 ${result.color}로 선택했습니다. 계속 다른 색을 뽑거나 붓으로 전환하세요.`,
      );
    })
    .catch((error) => {
      console.error(error);
      pushStatus("색상을 가져오지 못했습니다.");
    });
}

function startRetouchDrawing(
  {
    appendRetouchPoint,
    inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef,
    lastInpaintingRetouchPointRef,
    setRetouchPreview,
    stageRef,
  }: UseWorkspaceInpaintingPointerHandlersOptions,
  point: ImagePoint,
  event: PointerEvent,
  tool: RetouchDrawTool,
): void {
  inpaintingRetouchDrawingRef.current = true;
  inpaintingRetouchPointsRef.current = [];
  lastInpaintingRetouchPointRef.current = null;
  setRetouchPreview(null);
  appendRetouchPoint(point, tool);
  capturePointerSafely(stageRef.current, event.pointerId);
}

function commitRetouchPoints(
  {
    applyRetouchPoints,
    inpaintingBrushRadius,
    inpaintingTool,
    selectedPageIdRef,
    setPatternMaskStrokesByPage,
  }: UseWorkspaceInpaintingPointerHandlersOptions,
  points: ImagePoint[],
): void {
  if (inpaintingTool === "brush" || inpaintingTool === "eraser") {
    void applyRetouchPoints(inpaintingTool, points);
  } else if (inpaintingTool === "mask" && points.length > 0) {
    const pageId = selectedPageIdRef.current;
    if (pageId) {
      setPatternMaskStrokesByPage((current) =>
        appendMaskStroke(current, pageId, points, inpaintingBrushRadius),
      );
    }
  }
}
