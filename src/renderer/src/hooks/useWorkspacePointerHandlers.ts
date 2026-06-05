import { useCallback, useRef, type Dispatch, type MutableRefObject, type PointerEvent, type RefObject, type SetStateAction } from "react";
import type { ChapterSnapshot, InpaintingMaskStroke, MangaPage, TranslationBlock } from "../../../shared/types";
import {
  applyEditableBlockBbox,
  resolveEditableBlockBbox
} from "../../../shared/geometry";
import { isUsableRegionBbox } from "../../../shared/region";
import type { InpaintingTool } from "../inpainting/InpaintingContext";
import type { RetouchPreviewState } from "./useInpaintingRetouch";
import { regionSelectionToBbox, type RegionSelectionState } from "../lib/appHelpers";

type DragMode = "move" | "resize";

type DragState = {
  mode: DragMode;
  blockId: string;
  startX: number;
  startY: number;
  startBbox: { x: number; y: number; w: number; h: number };
};

type UseWorkspacePointerHandlersOptions = {
  appendRetouchPoint: (point: { x: number; y: number }, tool?: "brush" | "eraser" | "mask") => void;
  applyRetouchPoints: (tool: "brush" | "eraser", points: Array<{ x: number; y: number }>) => Promise<void>;
  currentChapter: ChapterSnapshot | null;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingBrushRadius: number;
  inpaintingRetouchDrawingRef: MutableRefObject<boolean>;
  inpaintingRetouchPointsRef: MutableRefObject<Array<{ x: number; y: number }>>;
  inpaintingTool: InpaintingTool;
  inpaintingToolActive: boolean;
  jobActive: boolean;
  lastInpaintingRetouchPointRef: MutableRefObject<{ x: number; y: number } | null>;
  pushStatus: (line: string) => void;
  regionSelection: RegionSelectionState | null;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  selectedPageIdRef: MutableRefObject<string | null>;
  selectedPageImageDataUrl: string;
  selectedPageImagePath: string | null;
  setInpaintingPaintColor: Dispatch<SetStateAction<string>>;
  setInpaintingTool: Dispatch<SetStateAction<InpaintingTool>>;
  setPatternMaskStrokesByPage: Dispatch<SetStateAction<Record<string, InpaintingMaskStroke[]>>>;
  setRegionSelection: Dispatch<SetStateAction<RegionSelectionState | null>>;
  setRetouchCursorPoint: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  setRetouchPreview: Dispatch<SetStateAction<RetouchPreviewState | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  stageRef: RefObject<HTMLDivElement | null>;
  translateSelectedRegion: (bbox: { x: number; y: number; w: number; h: number }) => Promise<void>;
  updateCurrentChapter: (pageId: string, updater: (chapter: ChapterSnapshot) => ChapterSnapshot) => void;
};

export function useWorkspacePointerHandlers({
  appendRetouchPoint,
  applyRetouchPoints,
  currentChapter,
  imageRef,
  inpaintingBrushRadius,
  inpaintingRetouchDrawingRef,
  inpaintingRetouchPointsRef,
  inpaintingTool,
  inpaintingToolActive,
  jobActive,
  lastInpaintingRetouchPointRef,
  pushStatus,
  regionSelection,
  selectedPage,
  selectedPageEditLocked,
  selectedPageIdRef,
  selectedPageImageDataUrl,
  selectedPageImagePath,
  setInpaintingPaintColor,
  setInpaintingTool,
  setPatternMaskStrokesByPage,
  setRegionSelection,
  setRetouchCursorPoint,
  setRetouchPreview,
  setSelectedBlockId,
  stageRef,
  translateSelectedRegion,
  updateCurrentChapter
}: UseWorkspacePointerHandlersOptions): {
  onBlockPointerDown: (event: PointerEvent, block: TranslationBlock, mode: DragMode) => void;
  onStagePointerDown: (event: PointerEvent) => void;
  onStagePointerLeave: () => void;
  onStagePointerMove: (event: PointerEvent) => void;
  onStagePointerUp: (event: PointerEvent) => void;
  startRegionTranslationSelection: () => void;
} {
  const dragRef = useRef<DragState | null>(null);

  const startRegionTranslationSelection = useCallback(() => {
    if (!selectedPage || !selectedPageImageDataUrl || jobActive) {
      return;
    }

    if (regionSelection?.active) {
      setRegionSelection(null);
      pushStatus("영역 번역 선택을 취소했습니다.");
      return;
    }

    setSelectedBlockId(null);
    setInpaintingTool("none");
    setRegionSelection({
      active: true,
      dragging: false,
      start: { x: 0, y: 0 },
      current: { x: 0, y: 0 }
    });
    pushStatus("번역할 영역을 드래그하세요.");
  }, [jobActive, pushStatus, regionSelection?.active, selectedPage, selectedPageImageDataUrl, setInpaintingTool, setRegionSelection, setSelectedBlockId]);

  const getNormalizedImagePoint = useCallback(
    (event: PointerEvent): { x: number; y: number } | null => {
      const stage = stageRef.current;
      if (!stage) {
        return null;
      }
      const rect = imageRef.current?.getBoundingClientRect() ?? stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }
      return {
        x: Math.max(0, Math.min(1000, ((event.clientX - rect.left) / rect.width) * 1000)),
        y: Math.max(0, Math.min(1000, ((event.clientY - rect.top) / rect.height) * 1000))
      };
    },
    [imageRef, stageRef]
  );

  const getImagePixelPoint = useCallback(
    (event: PointerEvent): { x: number; y: number } | null => {
      const stage = stageRef.current;
      const page = selectedPage;
      if (!stage || !page) {
        return null;
      }
      const rect = imageRef.current?.getBoundingClientRect() ?? stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }
      return {
        x: Math.max(0, Math.min(page.width - 1, ((event.clientX - rect.left) / rect.width) * page.width)),
        y: Math.max(0, Math.min(page.height - 1, ((event.clientY - rect.top) / rect.height) * page.height))
      };
    },
    [imageRef, selectedPage, stageRef]
  );

  const onBlockPointerDown = useCallback(
    (event: PointerEvent, block: TranslationBlock, mode: DragMode) => {
      if (!stageRef.current || selectedPageEditLocked || regionSelection?.active || inpaintingToolActive) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSelectedBlockId(block.id);
      const pageSize = selectedPage ? { width: selectedPage.width, height: selectedPage.height } : null;
      const displayText = block.translatedText || block.sourceText || "...";
      const target = resolveEditableBlockBbox(block, pageSize, displayText);
      dragRef.current = {
        mode,
        blockId: block.id,
        startX: event.clientX,
        startY: event.clientY,
        startBbox: target.bbox
      };
      capturePointerSafely(stageRef.current, event.pointerId);
    },
    [inpaintingToolActive, regionSelection?.active, selectedPage, selectedPageEditLocked, setSelectedBlockId, stageRef]
  );

  const onStagePointerDown = useCallback(
    (event: PointerEvent) => {
      if (inpaintingToolActive) {
        const point = getImagePixelPoint(event);
        if (!point || !stageRef.current) {
          return;
        }
        if (inpaintingTool === "brush" || inpaintingTool === "eraser" || inpaintingTool === "mask") {
          setRetouchCursorPoint(point);
        }
        event.preventDefault();
        event.stopPropagation();
        setSelectedBlockId(null);
        if (inpaintingTool === "picker") {
          const imagePath = selectedPageImagePath ?? selectedPage?.imagePath;
          if (imagePath) {
            void window.mangaApi
              .sampleInpaintingColor({ imagePath, x: point.x, y: point.y })
              .then((result) => {
                setInpaintingPaintColor(result.color);
                pushStatus(`붓 색상을 ${result.color}로 선택했습니다. 계속 다른 색을 뽑거나 붓으로 전환하세요.`);
              })
              .catch((error) => {
                console.error(error);
                pushStatus("색상을 가져오지 못했습니다.");
              });
          }
          return;
        }
        if (inpaintingTool === "brush" || inpaintingTool === "eraser" || inpaintingTool === "mask") {
          inpaintingRetouchDrawingRef.current = true;
          inpaintingRetouchPointsRef.current = [];
          lastInpaintingRetouchPointRef.current = null;
          setRetouchPreview(null);
          appendRetouchPoint(point, inpaintingTool);
          capturePointerSafely(stageRef.current, event.pointerId);
        }
        return;
      }

      if (!regionSelection?.active) {
        setSelectedBlockId(null);
        return;
      }

      const point = getNormalizedImagePoint(event);
      if (!point || !stageRef.current) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setSelectedBlockId(null);
      setRegionSelection({
        active: true,
        dragging: true,
        start: point,
        current: point
      });
      capturePointerSafely(stageRef.current, event.pointerId);
    },
    [
      appendRetouchPoint,
      getImagePixelPoint,
      getNormalizedImagePoint,
      inpaintingRetouchDrawingRef,
      inpaintingRetouchPointsRef,
      inpaintingTool,
      inpaintingToolActive,
      lastInpaintingRetouchPointRef,
      pushStatus,
      regionSelection?.active,
      selectedPage,
      selectedPageImagePath,
      setInpaintingPaintColor,
      setRegionSelection,
      setRetouchCursorPoint,
      setRetouchPreview,
      setSelectedBlockId,
      stageRef
    ]
  );

  const onStagePointerMove = useCallback(
    (event: PointerEvent) => {
      if (inpaintingToolActive) {
        const point = getImagePixelPoint(event);
        if (point && (inpaintingTool === "brush" || inpaintingTool === "eraser" || inpaintingTool === "mask")) {
          setRetouchCursorPoint(point);
        }
        if (point && inpaintingRetouchDrawingRef.current && (inpaintingTool === "brush" || inpaintingTool === "eraser" || inpaintingTool === "mask")) {
          appendRetouchPoint(point, inpaintingTool);
        }
        return;
      }

      if (regionSelection?.active && regionSelection.dragging) {
        const point = getNormalizedImagePoint(event);
        if (point) {
          setRegionSelection((current) => (current?.active ? { ...current, current: point } : current));
        }
        return;
      }

      const drag = dragRef.current;
      const page = selectedPage;
      const stage = stageRef.current;
      if (!drag || !page || !stage || !currentChapter || selectedPageEditLocked) {
        return;
      }
      const rect = imageRef.current?.getBoundingClientRect() ?? stage.getBoundingClientRect();
      const dx = ((event.clientX - drag.startX) / Math.max(1, rect.width)) * 1000;
      const dy = ((event.clientY - drag.startY) / Math.max(1, rect.height)) * 1000;
      const next =
        drag.mode === "move"
          ? {
              ...drag.startBbox,
              x: drag.startBbox.x + dx,
              y: drag.startBbox.y + dy
            }
          : {
              ...drag.startBbox,
              w: drag.startBbox.w + dx,
              h: drag.startBbox.h + dy
            };

      updateCurrentChapter(page.id, (chapter) => ({
        ...chapter,
        pages: chapter.pages.map((candidate) =>
          candidate.id !== page.id
            ? candidate
            : {
                ...candidate,
                updatedAt: new Date().toISOString(),
                blocks: candidate.blocks.map((block) =>
                  block.id === drag.blockId
                    ? applyEditableBlockBbox(block, next, { width: page.width, height: page.height }, block.translatedText || block.sourceText || "...")
                    : block
                )
              }
        )
      }));
    },
    [
      appendRetouchPoint,
      currentChapter,
      getImagePixelPoint,
      getNormalizedImagePoint,
      imageRef,
      inpaintingRetouchDrawingRef,
      inpaintingTool,
      inpaintingToolActive,
      regionSelection,
      selectedPage,
      selectedPageEditLocked,
      setRegionSelection,
      setRetouchCursorPoint,
      stageRef,
      updateCurrentChapter
    ]
  );

  const onStagePointerUp = useCallback(
    (event: PointerEvent) => {
      if (inpaintingRetouchDrawingRef.current) {
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
              [pageId]: [...(current[pageId] ?? []), { points, radiusPx: inpaintingBrushRadius }].slice(-200)
            }));
          }
        }
        window.setTimeout(() => setRetouchPreview(null), 180);
        return;
      }

      if (regionSelection?.active && regionSelection.dragging) {
        releasePointerCaptureSafely(stageRef.current, event.pointerId);
        const bbox = regionSelectionToBbox(regionSelection);
        setRegionSelection(null);
        if (!isUsableRegionBbox(bbox, 10)) {
          pushStatus("선택 영역이 너무 작습니다.");
          return;
        }
        void translateSelectedRegion(bbox);
        return;
      }

      if (dragRef.current) {
        releasePointerCaptureSafely(stageRef.current, event.pointerId);
      }
      dragRef.current = null;
    },
    [
      applyRetouchPoints,
      inpaintingBrushRadius,
      inpaintingRetouchDrawingRef,
      inpaintingRetouchPointsRef,
      inpaintingTool,
      lastInpaintingRetouchPointRef,
      pushStatus,
      regionSelection,
      selectedPageIdRef,
      setPatternMaskStrokesByPage,
      setRegionSelection,
      setRetouchPreview,
      stageRef,
      translateSelectedRegion
    ]
  );

  const onStagePointerLeave = useCallback(() => {
    if (!inpaintingRetouchDrawingRef.current) {
      setRetouchCursorPoint(null);
    }
  }, [inpaintingRetouchDrawingRef, setRetouchCursorPoint]);

  return {
    onBlockPointerDown,
    onStagePointerDown,
    onStagePointerLeave,
    onStagePointerMove,
    onStagePointerUp,
    startRegionTranslationSelection
  };
}

function capturePointerSafely(element: HTMLElement | null, pointerId: number): void {
  try {
    element?.setPointerCapture(pointerId);
  } catch {
    // Pointer capture can fail if the pointer was already released by the browser.
  }
}

function releasePointerCaptureSafely(element: HTMLElement | null, pointerId: number): void {
  try {
    if (element?.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  } catch {
    // Ignore stale pointer ids. The interaction state is reset by the caller.
  }
}
