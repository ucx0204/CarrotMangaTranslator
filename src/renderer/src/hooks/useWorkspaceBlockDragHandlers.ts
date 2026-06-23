import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { BBox, TranslationBlock } from "../../../shared/textTypes";
import {
  applyEditableBlockBbox,
  resolveEditableBlockBbox,
} from "../../../shared/geometry";
import type { ChapterSnapshot, MangaPage } from "./hookLibraryTypes";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";
import {
  describeDragBbox,
  resolveDraggedBbox,
  type DragHud,
  type DragMode,
  type DragState,
} from "./workspacePointerGeometry";

type UseWorkspaceBlockDragHandlersOptions = {
  currentChapter: ChapterSnapshot | null;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingToolActive: boolean;
  regionSelectionActive: boolean;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  setSelectedBlockId: (blockId: string | null) => void;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  stageRef: RefObject<HTMLDivElement | null>;
  updateCurrentChapter: (
    pageId: string,
    updater: (chapter: ChapterSnapshot) => ChapterSnapshot,
  ) => void;
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
    dragRef.current = null;
    setDragHud(null);
    if (stageRef.current) {
      stageRef.current.style.cursor = "";
    }
  }, [dragRef, setDragHud, stageRef]);
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
  return useCallback(() => {
    const drag = dragRef.current;
    if (!drag) {
      return false;
    }
    if (selectedPage && currentChapter) {
      updateCurrentChapter(selectedPage.id, (chapter) =>
        applyDraggedBlockBbox(chapter, selectedPage, drag, drag.startBbox),
      );
    }
    clearDrag();
    return true;
  }, [clearDrag, currentChapter, dragRef, selectedPage, updateCurrentChapter]);
}

function useBlockPointerDown(
  {
    inpaintingToolActive,
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
      stageRef.current.style.cursor =
        mode === "move" ? "grabbing" : "nwse-resize";
      capturePointerSafely(stageRef.current, event.pointerId);
    },
    [
      dragRef,
      inpaintingToolActive,
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
    selectedPage,
    selectedPageEditLocked,
    stageRef,
    updateCurrentChapter,
  }: UseWorkspaceBlockDragHandlersOptions,
  dragRef: BlockDragRef,
  setDragHud: SetDragHud,
): (event: PointerEvent) => void {
  return useCallback(
    (event) => {
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
      const next = resolveDraggedBbox(drag, event, rect);

      setDragHud({
        mode: drag.mode,
        label: describeDragBbox(drag.mode, next, {
          width: page.width,
          height: page.height,
        }),
      });
      updateCurrentChapter(page.id, (chapter) =>
        applyDraggedBlockBbox(chapter, page, drag, next),
      );
    },
    [
      currentChapter,
      dragRef,
      imageRef,
      selectedPage,
      selectedPageEditLocked,
      setDragHud,
      stageRef,
      updateCurrentChapter,
    ],
  );
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
  };
  if (pageSize) {
    setDragHud({
      mode,
      label: describeDragBbox(mode, target.bbox, pageSize),
    });
  }
}

function applyDraggedBlockBbox(
  chapter: ChapterSnapshot,
  page: MangaPage,
  drag: DragState,
  bbox: BBox,
): ChapterSnapshot {
  return {
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
                    bbox,
                    { width: page.width, height: page.height },
                    block.translatedText || block.sourceText || "...",
                  )
                : block,
            ),
          },
    ),
  };
}
