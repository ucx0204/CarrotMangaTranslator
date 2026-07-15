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
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { ChapterSnapshot, MangaPage } from "./hookLibraryTypes";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";
import { resolveEditableBlockBbox } from "../lib/blockFormatGeometry";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";
import {
  describeDragBbox,
  type DragHud,
  type DragMode,
  type DragState,
} from "./workspacePointerGeometry";
import {
  applyResolvedBlockDrag,
  resolveBlockDrag,
  resolveDragCursor,
  restoreDraggedBlock,
  type BlockDragResolution,
} from "./workspaceBlockDragModel";

type UseWorkspaceBlockDragHandlersOptions = {
  currentChapter: ChapterSnapshot | null;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingToolActive: boolean;
  jobActive: boolean;
  regionSelectionActive: boolean;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  setSelectedBlockId: (blockId: string | null) => void;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  stageRef: RefObject<HTMLDivElement | null>;
  updateCurrentChapter: UpdateCurrentChapter;
};

type BlockDragRef = MutableRefObject<DragState | null>;
type SetDragHud = Dispatch<SetStateAction<DragHud | null>>;

export function useWorkspaceBlockDragHandlers(
  options: UseWorkspaceBlockDragHandlersOptions,
): {
  cancelActiveDrag: () => boolean;
  dragHud: DragHud | null;
  finishDrag: (event: PointerEvent) => void;
  onBlockPointerDown: (
    event: PointerEvent,
    block: TranslationBlock,
    mode: DragMode,
  ) => void;
  onBlockPointerMove: (event: PointerEvent) => void;
} {
  const dragRef = useRef<DragState | null>(null);
  const [dragHud, setDragHud] = useState<DragHud | null>(null);
  const clearDrag = useClearBlockDrag(dragRef, setDragHud, options.stageRef);
  useClearDragOnPageChange(
    options.selectedPage?.id ?? null,
    dragRef,
    clearDrag,
  );
  const cancelActiveDrag = useCancelBlockDrag(options, dragRef, clearDrag);
  const onBlockPointerDown = useBlockPointerDown(options, dragRef, setDragHud);
  const onBlockPointerMove = useBlockPointerMove(options, dragRef, setDragHud);
  const finishDrag = useFinishBlockDrag(options.stageRef, dragRef, clearDrag);

  return {
    cancelActiveDrag,
    dragHud,
    finishDrag,
    onBlockPointerDown,
    onBlockPointerMove,
  };
}

function useClearBlockDrag(
  dragRef: BlockDragRef,
  setDragHud: SetDragHud,
  stageRef: RefObject<HTMLDivElement | null>,
): () => void {
  return useCallback(() => {
    const pointerId = dragRef.current?.pointerId;
    if (pointerId !== undefined) {
      releasePointerCaptureSafely(stageRef.current, pointerId);
    }
    dragRef.current = null;
    setDragHud(null);
    if (stageRef.current) {
      stageRef.current.style.cursor = "";
    }
  }, [dragRef, setDragHud, stageRef]);
}

function useClearDragOnPageChange(
  pageId: string | null,
  dragRef: BlockDragRef,
  clearDrag: () => void,
): void {
  useEffect(() => {
    if (dragRef.current) clearDrag();
  }, [clearDrag, dragRef, pageId]);
}

function useCancelBlockDrag(
  {
    currentChapter,
    selectedPage,
    updateCurrentChapter,
  }: UseWorkspaceBlockDragHandlersOptions,
  dragRef: BlockDragRef,
  clearDrag: () => void,
): () => boolean {
  const { t } = useTranslation("renderer");
  return useCallback(() => {
    const drag = dragRef.current;
    if (!drag) {
      return false;
    }
    if (selectedPage && currentChapter) {
      updateCurrentChapter(
        selectedPage.id,
        (chapter) => restoreDraggedBlock(chapter, selectedPage, drag),
        {
          label: t("workspaceHistory.dragBlock"),
          mergeKey: `drag:${drag.blockId}`,
        },
      );
    }
    clearDrag();
    return true;
  }, [
    clearDrag,
    currentChapter,
    dragRef,
    selectedPage,
    t,
    updateCurrentChapter,
  ]);
}

function useBlockPointerDown(
  {
    inpaintingToolActive,
    jobActive,
    regionSelectionActive,
    selectedPage,
    selectedPageEditLocked,
    setSelectedBlockId,
    setSelectedBlockIds,
    stageRef,
  }: UseWorkspaceBlockDragHandlersOptions,
  dragRef: BlockDragRef,
  setDragHud: SetDragHud,
): (event: PointerEvent, block: TranslationBlock, mode: DragMode) => void {
  return useCallback(
    (event, block, mode) => {
      if (
        !stageRef.current ||
        jobActive ||
        selectedPageEditLocked ||
        regionSelectionActive ||
        inpaintingToolActive
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Ctrl/⌘+click toggles multi-selection without starting a drag.
      if (event.ctrlKey || event.metaKey) {
        setSelectedBlockId(block.id);
        setSelectedBlockIds((current) =>
          current.includes(block.id)
            ? current.filter((id) => id !== block.id)
            : [...current, block.id],
        );
        return;
      }
      setSelectedBlockId(block.id);
      setSelectedBlockIds([block.id]);
      startBlockDrag({ block, dragRef, event, mode, selectedPage, setDragHud });
      stageRef.current.style.cursor = resolveDragCursor(mode);
      capturePointerSafely(stageRef.current, event.pointerId);
    },
    [
      dragRef,
      inpaintingToolActive,
      jobActive,
      regionSelectionActive,
      selectedPage,
      selectedPageEditLocked,
      setDragHud,
      setSelectedBlockId,
      setSelectedBlockIds,
      stageRef,
    ],
  );
}

function useBlockPointerMove(
  {
    currentChapter,
    imageRef,
    jobActive,
    selectedPage,
    selectedPageEditLocked,
    stageRef,
    updateCurrentChapter,
  }: UseWorkspaceBlockDragHandlersOptions,
  dragRef: BlockDragRef,
  setDragHud: SetDragHud,
): (event: PointerEvent) => void {
  const { t } = useTranslation("renderer");
  const { t: tComponents } = useTranslation("components");
  return useCallback(
    (event) => {
      const context = resolveActiveBlockDrag(
        dragRef.current,
        selectedPage,
        stageRef.current,
        Boolean(currentChapter) && !jobActive && !selectedPageEditLocked,
      );
      if (!context) return;
      const { drag, page, stage } = context;
      const rect =
        imageRef.current?.getBoundingClientRect() ??
        stage.getBoundingClientRect();
      const resolution = resolveBlockDrag(drag, event, rect, page);
      if (!resolution) return;
      setDragHud(
        resolveBlockDragHud(resolution, drag.mode, {
          invalidCurve: tComponents("transform.hud.invalidCurve"),
          invalidPerspective: tComponents("transform.hud.invalidPerspective"),
          outsidePage: tComponents("transform.hud.outsidePage"),
          snapped: tComponents("transform.hud.snapped"),
        }),
      );
      if (resolution.invalid) return;
      updateCurrentChapter(
        page.id,
        (chapter) => applyResolvedBlockDrag(chapter, page, drag, resolution),
        {
          label: t("workspaceHistory.dragBlock"),
          mergeKey: `drag:${drag.blockId}`,
        },
      );
    },
    [
      currentChapter,
      dragRef,
      imageRef,
      jobActive,
      selectedPage,
      selectedPageEditLocked,
      setDragHud,
      stageRef,
      t,
      tComponents,
      updateCurrentChapter,
    ],
  );
}

function resolveActiveBlockDrag(
  drag: DragState | null,
  page: MangaPage | null,
  stage: HTMLDivElement | null,
  enabled: boolean,
): { drag: DragState; page: MangaPage; stage: HTMLDivElement } | null {
  return drag && page && stage && enabled ? { drag, page, stage } : null;
}

function resolveBlockDragHud(
  resolution: BlockDragResolution,
  mode: DragMode,
  labels: {
    invalidCurve: string;
    invalidPerspective: string;
    outsidePage: string;
    snapped: string;
  },
): DragHud {
  if (resolution.invalid) {
    return {
      mode,
      label:
        resolution.invalidKind === "curve"
          ? labels.invalidCurve
          : resolution.invalidKind === "outside"
            ? labels.outsidePage
            : labels.invalidPerspective,
      invalid: true,
    };
  }
  return {
    mode,
    label: resolution.snapped
      ? `${resolution.label} · ${labels.snapped}`
      : resolution.label,
  };
}

function useFinishBlockDrag(
  stageRef: RefObject<HTMLDivElement | null>,
  dragRef: BlockDragRef,
  clearDrag: () => void,
): (event: PointerEvent) => void {
  return useCallback(
    (event) => {
      if (dragRef.current) {
        releasePointerCaptureSafely(stageRef.current, event.pointerId);
      }
      clearDrag();
    },
    [clearDrag, dragRef, stageRef],
  );
}

function startBlockDrag({
  block,
  dragRef,
  event,
  mode,
  selectedPage,
  setDragHud,
}: {
  block: TranslationBlock;
  dragRef: BlockDragRef;
  event: PointerEvent;
  mode: DragMode;
  selectedPage: MangaPage | null;
  setDragHud: SetDragHud;
}): void {
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
    startBlock: block,
    pointerId: event.pointerId,
  };
  if (pageSize) {
    setDragHud({
      mode,
      label:
        mode === "rotate"
          ? `${block.rotationDeg ?? 0}°`
          : describeDragBbox(mode, target.bbox, pageSize),
    });
  }
}
