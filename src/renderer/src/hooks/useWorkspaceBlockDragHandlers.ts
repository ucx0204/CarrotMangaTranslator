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
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { DragMode } from "../lib/workspaceInteractionTypes";
import type { WorkspaceInteractionPreviewStore } from "../lib/workspaceInteractionPreview";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";
import { useEventCallback } from "./useEventCallback";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";
import {
  applyResolvedBlockDrag,
  resolveBlockDrag,
  resolveDragCursor,
} from "./workspaceBlockDragModel";
import {
  hasPointerChanged,
  resolveBlockDragHud,
  resolveBlockDragPreviews,
  resolveInitialDragHud,
  resolveMoveStartBlocks,
  startBlockDrag,
  type ActiveBlockDrag,
} from "./workspaceBlockDragInteraction";

type UseWorkspaceBlockDragHandlersOptions = {
  currentChapter: ChapterSnapshot | null;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingToolActive: boolean;
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
  jobActive: boolean;
  regionSelectionActive: boolean;
  selectedBlockIds: readonly string[];
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  setSelectedBlockId: (blockId: string | null) => void;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  stageRef: RefObject<HTMLDivElement | null>;
  updateCurrentChapter: UpdateCurrentChapter;
};

type BlockDragRef = MutableRefObject<ActiveBlockDrag | null>;

export function useWorkspaceBlockDragHandlers(
  options: UseWorkspaceBlockDragHandlersOptions,
): {
  cancelActiveDrag: () => boolean;
  finishDrag: (event: PointerEvent) => void;
  onBlockPointerDown: (
    event: PointerEvent,
    block: TranslationBlock,
    mode: DragMode,
  ) => void;
  onBlockPointerMove: (event: PointerEvent) => void;
} {
  const dragRef = useRef<ActiveBlockDrag | null>(null);
  const clearDrag = useClearBlockDrag(
    dragRef,
    options.interactionPreviewStore,
    options.stageRef,
  );
  useClearDragOnPageChange(
    options.selectedPage?.id ?? null,
    dragRef,
    clearDrag,
  );
  const cancelActiveDrag = useCallback(() => {
    if (!dragRef.current) return false;
    clearDrag();
    return true;
  }, [clearDrag]);
  const onBlockPointerDown = useBlockPointerDown(options, dragRef);
  const onBlockPointerMove = useBlockPointerMove(options, dragRef);
  const finishDrag = useFinishBlockDrag(options, dragRef, clearDrag);

  return {
    cancelActiveDrag,
    finishDrag,
    onBlockPointerDown,
    onBlockPointerMove,
  };
}

function useClearBlockDrag(
  dragRef: BlockDragRef,
  previewStore: WorkspaceInteractionPreviewStore,
  stageRef: RefObject<HTMLDivElement | null>,
): () => void {
  return useCallback(() => {
    const pointerId = dragRef.current?.drag.pointerId;
    if (pointerId !== undefined) {
      releasePointerCaptureSafely(stageRef.current, pointerId);
    }
    dragRef.current = null;
    previewStore.set({
      blockPreview: null,
      blockPreviews: new Map(),
      dragHud: null,
    });
    if (stageRef.current) {
      stageRef.current.style.cursor = "";
    }
  }, [dragRef, previewStore, stageRef]);
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

function useBlockPointerDown(
  options: UseWorkspaceBlockDragHandlersOptions,
  dragRef: BlockDragRef,
): (event: PointerEvent, block: TranslationBlock, mode: DragMode) => void {
  return useEventCallback((event, block, mode) =>
    beginBlockPointerDrag({ block, dragRef, event, mode, options }),
  );
}

function beginBlockPointerDrag({
  block,
  dragRef,
  event,
  mode,
  options,
}: {
  block: TranslationBlock;
  dragRef: BlockDragRef;
  event: PointerEvent;
  mode: DragMode;
  options: UseWorkspaceBlockDragHandlersOptions;
}): void {
  const stage = options.stageRef.current;
  const page = options.selectedPage;
  if (
    !stage ||
    !page ||
    options.jobActive ||
    options.selectedPageEditLocked ||
    options.regionSelectionActive ||
    options.inpaintingToolActive
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.ctrlKey || event.metaKey) {
    options.setSelectedBlockId(block.id);
    options.setSelectedBlockIds((current) =>
      current.includes(block.id)
        ? current.filter((id) => id !== block.id)
        : [...current, block.id],
    );
    return;
  }
  const moveStartBlocks = resolveMoveStartBlocks(
    page,
    options.selectedBlockIds,
    block,
    mode,
  );
  options.setSelectedBlockId(block.id);
  if (moveStartBlocks.length === 1) {
    options.setSelectedBlockIds((current) =>
      current.length === 1 && current[0] === block.id ? current : [block.id],
    );
  }
  const pointerRect =
    options.imageRef.current?.getBoundingClientRect() ??
    stage.getBoundingClientRect();
  const activeDrag = startBlockDrag({
    block,
    event,
    mode,
    moveStartBlocks,
    page,
    pointerRect,
  });
  dragRef.current = activeDrag;
  options.interactionPreviewStore.set({
    blockPreview: null,
    blockPreviews: new Map(
      activeDrag.moveStartBlocks.map((candidate) => [candidate.id, candidate]),
    ),
    dragHud: resolveInitialDragHud(activeDrag.drag, page),
  });
  stage.style.cursor = resolveDragCursor(mode);
  capturePointerSafely(stage, event.pointerId);
}

function useBlockPointerMove(
  {
    interactionPreviewStore,
    jobActive,
    selectedPageEditLocked,
  }: UseWorkspaceBlockDragHandlersOptions,
  dragRef: BlockDragRef,
): (event: PointerEvent) => void {
  const { t: tComponents } = useTranslation("components");
  return useCallback(
    (event) => {
      const active = dragRef.current;
      if (!active || jobActive || selectedPageEditLocked) return;
      const resolution = resolveBlockDrag(
        active.drag,
        event,
        active.pointerRect,
        active.page,
        active.moveStartBlocks,
      );
      if (!resolution) return;
      active.pointerChanged ||= hasPointerChanged(active.drag, event);
      const dragHud = resolveBlockDragHud(resolution, active.drag.mode, {
        invalidCurve: tComponents("transform.hud.invalidCurve"),
        invalidPerspective: tComponents("transform.hud.invalidPerspective"),
        invalidWarp: tComponents("transform.hud.invalidWarp"),
        outsidePage: tComponents("transform.hud.outsidePage"),
        snapped: tComponents("transform.hud.snapped"),
      });
      if (resolution.invalid) {
        interactionPreviewStore.queue({ dragHud });
        return;
      }
      active.latestValidResolution = resolution;
      interactionPreviewStore.queue({
        blockPreview: null,
        blockPreviews: resolveBlockDragPreviews(active, resolution),
        dragHud,
      });
    },
    [
      dragRef,
      interactionPreviewStore,
      jobActive,
      selectedPageEditLocked,
      tComponents,
    ],
  );
}

function useFinishBlockDrag(
  {
    currentChapter,
    jobActive,
    selectedPageEditLocked,
    updateCurrentChapter,
  }: UseWorkspaceBlockDragHandlersOptions,
  dragRef: BlockDragRef,
  clearDrag: () => void,
): (event: PointerEvent) => void {
  const { t } = useTranslation("renderer");
  return useCallback(
    (event) => {
      const active = dragRef.current;
      if (!active) return;
      if (
        event.type !== "pointercancel" &&
        currentChapter &&
        !jobActive &&
        !selectedPageEditLocked
      ) {
        const finalResolution = resolveBlockDrag(
          active.drag,
          event,
          active.pointerRect,
          active.page,
          active.moveStartBlocks,
        );
        active.pointerChanged ||= hasPointerChanged(active.drag, event);
        if (finalResolution && !finalResolution.invalid) {
          active.latestValidResolution = finalResolution;
        }
        const resolution = active.latestValidResolution;
        if (resolution && active.pointerChanged) {
          updateCurrentChapter(
            active.page.id,
            (chapter) =>
              applyResolvedBlockDrag(
                chapter,
                active.page,
                active.drag,
                resolution,
                active.moveStartBlocks,
              ),
            {
              label: t("workspaceHistory.dragBlock"),
              mergeKey: `drag:${active.moveStartBlocks
                .map((block) => block.id)
                .sort()
                .join(",")}`,
            },
          );
        }
      }
      clearDrag();
    },
    [
      clearDrag,
      currentChapter,
      dragRef,
      jobActive,
      selectedPageEditLocked,
      t,
      updateCurrentChapter,
    ],
  );
}
