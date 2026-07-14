import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { InpaintingMaskStroke } from "../../../shared/inpaintingTypes";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import {
  appendRetouchStrokePoint,
  beginRetouchStroke,
  clearRetouchLiveOverlay,
  finishRetouchStroke,
  hideRetouchCursor,
  queueRetouchCursor,
  type RetouchLiveGeometry,
} from "../lib/retouchLiveOverlay";
import type { MangaPage } from "./hookLibraryTypes";
import { libraryGateway } from "./libraryGateway";
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
  appendRetouchPoint: (point: ImagePoint) => ImagePoint | null;
  applyRetouchPoints: (
    tool: "brush" | "eraser",
    points: ImagePoint[],
  ) => Promise<void>;
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
  const imagePointResolver = useImagePixelPoint(options);
  const onPointerDown = useInpaintingPointerDown(
    options,
    imagePointResolver.resolve,
    t,
  );
  const onPointerMove = useInpaintingPointerMove(
    options,
    imagePointResolver.resolve,
  );
  const onPointerUp = useInpaintingPointerUp(options);
  const { inpaintingRetouchDrawingRef, stageRef } = options;
  const onPointerLeave = useCallback(() => {
    if (!inpaintingRetouchDrawingRef.current) {
      hideRetouchCursor(stageRef.current);
      imagePointResolver.invalidate();
    }
  }, [imagePointResolver, inpaintingRetouchDrawingRef, stageRef]);
  const cancelDrawing = useCancelRetouchDrawing(options);

  return {
    cancelDrawing,
    onPointerDown,
    onPointerLeave,
    onPointerMove,
    onPointerUp,
  };
}

type ResolvedImagePoint = {
  geometry: RetouchLiveGeometry;
  point: ImagePoint;
};

type ImagePointResolver = {
  invalidate: () => void;
  resolve: (
    event: Pick<PointerEvent, "clientX" | "clientY">,
    refreshBounds?: boolean,
  ) => ResolvedImagePoint | null;
};

function useImagePixelPoint({
  imageRef,
  selectedPage,
  stageRef,
}: UseWorkspaceInpaintingPointerHandlersOptions): ImagePointResolver {
  const boundsRef = useRef<DOMRect | null>(null);
  const invalidate = useCallback(() => {
    boundsRef.current = null;
  }, []);
  const selectedPageId = selectedPage?.id;

  useEffect(() => {
    invalidate();
    const image = imageRef.current;
    const observer =
      image && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(invalidate)
        : null;
    if (image) observer?.observe(image);
    window.addEventListener("resize", invalidate);
    document.addEventListener("scroll", invalidate, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", invalidate);
      document.removeEventListener("scroll", invalidate, true);
    };
  }, [imageRef, invalidate, selectedPageId]);

  const resolve = useCallback(
    (
      event: Pick<PointerEvent, "clientX" | "clientY">,
      refreshBounds = false,
    ) => {
      const stage = stageRef.current;
      const page = selectedPage;
      if (!stage || !page) {
        return null;
      }
      if (refreshBounds || !boundsRef.current) {
        boundsRef.current =
          imageRef.current?.getBoundingClientRect() ??
          stage.getBoundingClientRect();
      }
      const rect = boundsRef.current;
      const point = resolveImagePixelPoint(event, rect, page);
      return point
        ? {
            geometry: {
              displayHeight: rect.height,
              displayWidth: rect.width,
              imageHeight: page.height,
              imageWidth: page.width,
            },
            point,
          }
        : null;
    },
    [imageRef, selectedPage, stageRef],
  );

  return { invalidate, resolve };
}

function useInpaintingPointerDown(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: ImagePointResolver["resolve"],
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
      }
      return true;
    },
    [getImagePixelPoint, options, t],
  );
}

function useCancelRetouchDrawing({
  inpaintingRetouchDrawingRef,
  inpaintingRetouchPointsRef,
  lastInpaintingRetouchPointRef,
  stageRef,
}: UseWorkspaceInpaintingPointerHandlersOptions): () => boolean {
  return useCallback(() => {
    if (!inpaintingRetouchDrawingRef.current) return false;
    inpaintingRetouchDrawingRef.current = false;
    inpaintingRetouchPointsRef.current = [];
    lastInpaintingRetouchPointRef.current = null;
    clearRetouchLiveOverlay(stageRef.current);
    return true;
  }, [
    inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef,
    lastInpaintingRetouchPointRef,
    stageRef,
  ]);
}

function useInpaintingPointerMove(
  options: UseWorkspaceInpaintingPointerHandlersOptions,
  getImagePixelPoint: ImagePointResolver["resolve"],
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!options.inpaintingToolActive) {
        return false;
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
      finishRetouchStroke(options.stageRef.current);
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
  t: TFunction<"renderer">,
): void {
  const imagePath = selectedPageImagePath ?? selectedPage?.imagePath;
  if (!imagePath) {
    return;
  }
  void libraryGateway
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

function getCoalescedPointerSamples(
  event: PointerEvent,
): Array<Pick<PointerEvent, "clientX" | "clientY">> {
  const nativeEvent = event.nativeEvent;
  const samples = nativeEvent.getCoalescedEvents?.() ?? [];
  if (samples.length === 0) return [event];
  const last = samples[samples.length - 1];
  return last?.clientX === event.clientX && last.clientY === event.clientY
    ? samples
    : [...samples, event];
}

function commitRetouchPoints(
  {
    applyRetouchPoints,
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
    void applyRetouchPoints(inpaintingTool, points);
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
