import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { InpaintingMaskStroke, MangaPage } from "../../../shared/types";
import { mangaGateway } from "../api/mangaGateway";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import type { RetouchPreviewState } from "./useInpaintingRetouch";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";

type ImagePoint = { x: number; y: number };

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

export function useWorkspaceInpaintingPointerHandlers({
  appendRetouchPoint,
  applyRetouchPoints,
  imageRef,
  inpaintingBrushRadius,
  inpaintingRetouchDrawingRef,
  inpaintingRetouchPointsRef,
  inpaintingTool,
  inpaintingToolActive,
  lastInpaintingRetouchPointRef,
  pushStatus,
  selectedPage,
  selectedPageIdRef,
  selectedPageImagePath,
  setInpaintingPaintColor,
  setPatternMaskStrokesByPage,
  setRetouchCursorPoint,
  setRetouchPreview,
  setSelectedBlockId,
  stageRef,
}: UseWorkspaceInpaintingPointerHandlersOptions): {
  onPointerDown: (event: PointerEvent) => boolean;
  onPointerLeave: () => void;
  onPointerMove: (event: PointerEvent) => boolean;
  onPointerUp: (event: PointerEvent) => boolean;
} {
  const getImagePixelPoint = useCallback(
    (event: PointerEvent): ImagePoint | null => {
      const stage = stageRef.current;
      const page = selectedPage;
      if (!stage || !page) {
        return null;
      }
      const rect =
        imageRef.current?.getBoundingClientRect() ??
        stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }
      return {
        x: Math.max(
          0,
          Math.min(
            page.width - 1,
            ((event.clientX - rect.left) / rect.width) * page.width,
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            page.height - 1,
            ((event.clientY - rect.top) / rect.height) * page.height,
          ),
        ),
      };
    },
    [imageRef, selectedPage, stageRef],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent): boolean => {
      if (!inpaintingToolActive) {
        return false;
      }

      const point = getImagePixelPoint(event);
      if (!point || !stageRef.current) {
        return true;
      }
      if (
        inpaintingTool === "brush" ||
        inpaintingTool === "eraser" ||
        inpaintingTool === "mask"
      ) {
        setRetouchCursorPoint(point);
      }
      event.preventDefault();
      event.stopPropagation();
      setSelectedBlockId(null);
      if (inpaintingTool === "picker") {
        const imagePath = selectedPageImagePath ?? selectedPage?.imagePath;
        if (imagePath) {
          void mangaGateway
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
        return true;
      }
      if (
        inpaintingTool === "brush" ||
        inpaintingTool === "eraser" ||
        inpaintingTool === "mask"
      ) {
        inpaintingRetouchDrawingRef.current = true;
        inpaintingRetouchPointsRef.current = [];
        lastInpaintingRetouchPointRef.current = null;
        setRetouchPreview(null);
        appendRetouchPoint(point, inpaintingTool);
        capturePointerSafely(stageRef.current, event.pointerId);
      }
      return true;
    },
    [
      appendRetouchPoint,
      getImagePixelPoint,
      inpaintingRetouchDrawingRef,
      inpaintingRetouchPointsRef,
      inpaintingTool,
      inpaintingToolActive,
      lastInpaintingRetouchPointRef,
      pushStatus,
      selectedPage,
      selectedPageImagePath,
      setInpaintingPaintColor,
      setRetouchCursorPoint,
      setRetouchPreview,
      setSelectedBlockId,
      stageRef,
    ],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent): boolean => {
      if (!inpaintingToolActive) {
        return false;
      }

      const point = getImagePixelPoint(event);
      if (
        point &&
        (inpaintingTool === "brush" ||
          inpaintingTool === "eraser" ||
          inpaintingTool === "mask")
      ) {
        setRetouchCursorPoint(point);
      }
      if (
        point &&
        inpaintingRetouchDrawingRef.current &&
        (inpaintingTool === "brush" ||
          inpaintingTool === "eraser" ||
          inpaintingTool === "mask")
      ) {
        appendRetouchPoint(point, inpaintingTool);
      }
      return true;
    },
    [
      appendRetouchPoint,
      getImagePixelPoint,
      inpaintingRetouchDrawingRef,
      inpaintingTool,
      inpaintingToolActive,
      setRetouchCursorPoint,
    ],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent): boolean => {
      if (!inpaintingRetouchDrawingRef.current) {
        return false;
      }

      releasePointerCaptureSafely(stageRef.current, event.pointerId);
      inpaintingRetouchDrawingRef.current = false;
      lastInpaintingRetouchPointRef.current = null;
      const points = inpaintingRetouchPointsRef.current;
      inpaintingRetouchPointsRef.current = [];
      if (inpaintingTool === "brush" || inpaintingTool === "eraser") {
        void applyRetouchPoints(inpaintingTool, points);
      } else if (inpaintingTool === "mask" && points.length > 0) {
        const pageId = selectedPageIdRef.current;
        if (pageId) {
          setPatternMaskStrokesByPage((current) => ({
            ...current,
            [pageId]: [
              ...(current[pageId] ?? []),
              { points, radiusPx: inpaintingBrushRadius },
            ].slice(-200),
          }));
        }
      }
      window.setTimeout(() => setRetouchPreview(null), 180);
      return true;
    },
    [
      applyRetouchPoints,
      inpaintingBrushRadius,
      inpaintingRetouchDrawingRef,
      inpaintingRetouchPointsRef,
      inpaintingTool,
      lastInpaintingRetouchPointRef,
      selectedPageIdRef,
      setPatternMaskStrokesByPage,
      setRetouchPreview,
      stageRef,
    ],
  );

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
