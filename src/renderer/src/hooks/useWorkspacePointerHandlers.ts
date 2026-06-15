import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  ChapterSnapshot,
  InpaintingMaskStroke,
  MangaPage,
  TranslationBlock,
} from "../../../shared/types";
import {
  applyEditableBlockBbox,
  resolveEditableBlockBbox,
} from "../../../shared/geometry";
import { isUsableRegionBbox } from "../../../shared/region";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import type { RetouchPreviewState } from "./useInpaintingRetouch";
import {
  regionSelectionToBbox,
  type RegionSelectionState,
} from "../lib/appHelpers";
import { useWorkspaceInpaintingPointerHandlers } from "./useWorkspaceInpaintingPointerHandlers";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";

type DragMode = "move" | "resize";

type DragState = {
  mode: DragMode;
  blockId: string;
  startX: number;
  startY: number;
  startBbox: { x: number; y: number; w: number; h: number };
};

export type DragHud = {
  mode: DragMode;
  label: string;
};

function describeDragBbox(
  mode: DragMode,
  bbox: { x: number; y: number; w: number; h: number },
  page: { width: number; height: number },
): string {
  if (mode === "resize") {
    const widthPx = Math.round((bbox.w / 1000) * page.width);
    const heightPx = Math.round((bbox.h / 1000) * page.height);
    return `${widthPx} × ${heightPx}px`;
  }
  const xPx = Math.round((bbox.x / 1000) * page.width);
  const yPx = Math.round((bbox.y / 1000) * page.height);
  return `${xPx}, ${yPx}`;
}

type UseWorkspacePointerHandlersOptions = {
  appendRetouchPoint: (
    point: { x: number; y: number },
    tool?: "brush" | "eraser" | "mask",
  ) => void;
  applyRetouchPoints: (
    tool: "brush" | "eraser",
    points: Array<{ x: number; y: number }>,
  ) => Promise<void>;
  currentChapter: ChapterSnapshot | null;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingBrushRadius: number;
  inpaintingRetouchDrawingRef: MutableRefObject<boolean>;
  inpaintingRetouchPointsRef: MutableRefObject<Array<{ x: number; y: number }>>;
  inpaintingTool: InpaintingTool;
  inpaintingToolActive: boolean;
  jobActive: boolean;
  lastInpaintingRetouchPointRef: MutableRefObject<{
    x: number;
    y: number;
  } | null>;
  pushStatus: (line: string) => void;
  regionSelection: RegionSelectionState | null;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  selectedPageIdRef: MutableRefObject<string | null>;
  selectedPageImageDataUrl: string;
  selectedPageImagePath: string | null;
  setInpaintingPaintColor: Dispatch<SetStateAction<string>>;
  setInpaintingTool: Dispatch<SetStateAction<InpaintingTool>>;
  setPatternMaskStrokesByPage: Dispatch<
    SetStateAction<Record<string, InpaintingMaskStroke[]>>
  >;
  setRegionSelection: Dispatch<SetStateAction<RegionSelectionState | null>>;
  setRetouchCursorPoint: Dispatch<
    SetStateAction<{ x: number; y: number } | null>
  >;
  setRetouchPreview: Dispatch<SetStateAction<RetouchPreviewState | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  stageRef: RefObject<HTMLDivElement | null>;
  translateSelectedRegion: (bbox: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) => Promise<void>;
  updateCurrentChapter: (
    pageId: string,
    updater: (chapter: ChapterSnapshot) => ChapterSnapshot,
  ) => void;
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
  updateCurrentChapter,
}: UseWorkspacePointerHandlersOptions): {
  onBlockPointerDown: (
    event: PointerEvent,
    block: TranslationBlock,
    mode: DragMode,
  ) => void;
  onStagePointerDown: (event: PointerEvent) => void;
  onStagePointerLeave: () => void;
  onStagePointerMove: (event: PointerEvent) => void;
  onStagePointerUp: (event: PointerEvent) => void;
  startRegionTranslationSelection: () => void;
  dragHud: DragHud | null;
} {
  const dragRef = useRef<DragState | null>(null);
  const [dragHud, setDragHud] = useState<DragHud | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      const drag = dragRef.current;
      if (drag) {
        const page = selectedPage;
        if (page && currentChapter) {
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
                        ? applyEditableBlockBbox(
                            block,
                            drag.startBbox,
                            { width: page.width, height: page.height },
                            block.translatedText || block.sourceText || "...",
                          )
                        : block,
                    ),
                  },
            ),
          }));
        }
        dragRef.current = null;
        setDragHud(null);
        if (stageRef.current) {
          stageRef.current.style.cursor = "";
        }
        return;
      }
      if (regionSelection?.active) {
        setRegionSelection(null);
        pushStatus("영역 번역 선택을 취소했습니다.");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    currentChapter,
    pushStatus,
    regionSelection?.active,
    selectedPage,
    setRegionSelection,
    stageRef,
    updateCurrentChapter,
  ]);

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
      current: { x: 0, y: 0 },
    });
    pushStatus("번역할 영역을 드래그하세요.");
  }, [
    jobActive,
    pushStatus,
    regionSelection?.active,
    selectedPage,
    selectedPageImageDataUrl,
    setInpaintingTool,
    setRegionSelection,
    setSelectedBlockId,
  ]);

  const getNormalizedImagePoint = useCallback(
    (event: PointerEvent): { x: number; y: number } | null => {
      const stage = stageRef.current;
      if (!stage) {
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
          Math.min(1000, ((event.clientX - rect.left) / rect.width) * 1000),
        ),
        y: Math.max(
          0,
          Math.min(1000, ((event.clientY - rect.top) / rect.height) * 1000),
        ),
      };
    },
    [imageRef, stageRef],
  );

  const {
    onPointerDown: onInpaintingPointerDown,
    onPointerLeave: onInpaintingPointerLeave,
    onPointerMove: onInpaintingPointerMove,
    onPointerUp: onInpaintingPointerUp,
  } = useWorkspaceInpaintingPointerHandlers({
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
  });

  const onBlockPointerDown = useCallback(
    (event: PointerEvent, block: TranslationBlock, mode: DragMode) => {
      if (
        !stageRef.current ||
        selectedPageEditLocked ||
        regionSelection?.active ||
        inpaintingToolActive
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSelectedBlockId(block.id);
      const pageSize = selectedPage
        ? { width: selectedPage.width, height: selectedPage.height }
        : null;
      const displayText = block.translatedText || block.sourceText || "...";
      const target = resolveEditableBlockBbox(block, pageSize, displayText);
      dragRef.current = {
        mode,
        blockId: block.id,
        startX: event.clientX,
        startY: event.clientY,
        startBbox: target.bbox,
      };
      if (pageSize) {
        setDragHud({
          mode,
          label: describeDragBbox(mode, target.bbox, pageSize),
        });
      }
      stageRef.current.style.cursor =
        mode === "move" ? "grabbing" : "nwse-resize";
      capturePointerSafely(stageRef.current, event.pointerId);
    },
    [
      inpaintingToolActive,
      regionSelection?.active,
      selectedPage,
      selectedPageEditLocked,
      setSelectedBlockId,
      stageRef,
    ],
  );

  const onStagePointerDown = useCallback(
    (event: PointerEvent) => {
      if (onInpaintingPointerDown(event)) {
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
        current: point,
      });
      capturePointerSafely(stageRef.current, event.pointerId);
    },
    [
      getNormalizedImagePoint,
      onInpaintingPointerDown,
      regionSelection?.active,
      setRegionSelection,
      setSelectedBlockId,
      stageRef,
    ],
  );

  const onStagePointerMove = useCallback(
    (event: PointerEvent) => {
      if (onInpaintingPointerMove(event)) {
        return;
      }

      if (regionSelection?.active && regionSelection.dragging) {
        const point = getNormalizedImagePoint(event);
        if (point) {
          setRegionSelection((current) =>
            current?.active ? { ...current, current: point } : current,
          );
        }
        return;
      }

      const drag = dragRef.current;
      const page = selectedPage;
      const stage = stageRef.current;
      if (
        !drag ||
        !page ||
        !stage ||
        !currentChapter ||
        selectedPageEditLocked
      ) {
        return;
      }
      const rect =
        imageRef.current?.getBoundingClientRect() ??
        stage.getBoundingClientRect();
      const dx =
        ((event.clientX - drag.startX) / Math.max(1, rect.width)) * 1000;
      const dy =
        ((event.clientY - drag.startY) / Math.max(1, rect.height)) * 1000;
      const next =
        drag.mode === "move"
          ? {
              ...drag.startBbox,
              x: drag.startBbox.x + dx,
              y: drag.startBbox.y + dy,
            }
          : {
              ...drag.startBbox,
              w: drag.startBbox.w + dx,
              h: drag.startBbox.h + dy,
            };

      setDragHud({
        mode: drag.mode,
        label: describeDragBbox(drag.mode, next, {
          width: page.width,
          height: page.height,
        }),
      });

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
                    ? applyEditableBlockBbox(
                        block,
                        next,
                        { width: page.width, height: page.height },
                        block.translatedText || block.sourceText || "...",
                      )
                    : block,
                ),
              },
        ),
      }));
    },
    [
      currentChapter,
      getNormalizedImagePoint,
      imageRef,
      onInpaintingPointerMove,
      regionSelection,
      selectedPage,
      selectedPageEditLocked,
      setRegionSelection,
      stageRef,
      updateCurrentChapter,
    ],
  );

  const onStagePointerUp = useCallback(
    (event: PointerEvent) => {
      if (onInpaintingPointerUp(event)) {
        return;
      }

      if (regionSelection?.active && regionSelection.dragging) {
        releasePointerCaptureSafely(stageRef.current, event.pointerId);
        const finalPoint = getNormalizedImagePoint(event);
        const completedSelection = finalPoint
          ? { ...regionSelection, current: finalPoint }
          : regionSelection;
        const bbox = regionSelectionToBbox(completedSelection);
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
      setDragHud(null);
      if (stageRef.current) {
        stageRef.current.style.cursor = "";
      }
    },
    [
      getNormalizedImagePoint,
      onInpaintingPointerUp,
      pushStatus,
      regionSelection,
      setRegionSelection,
      stageRef,
      translateSelectedRegion,
    ],
  );

  const onStagePointerLeave = useCallback(() => {
    onInpaintingPointerLeave();
  }, [onInpaintingPointerLeave]);

  return {
    onBlockPointerDown,
    onStagePointerDown,
    onStagePointerLeave,
    onStagePointerMove,
    onStagePointerUp,
    startRegionTranslationSelection,
    dragHud,
  };
}
