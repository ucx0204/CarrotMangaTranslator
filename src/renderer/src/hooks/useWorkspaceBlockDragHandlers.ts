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
import { resolveEditableBlockBbox } from "../lib/blockFormatGeometry";
import type { DragHud, DragMode } from "../lib/workspaceInteractionTypes";
import type { WorkspaceInteractionPreviewStore } from "../lib/workspaceInteractionPreview";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";
import {
  describeDragBbox,
  type DragState,
  type PointerRect,
} from "./workspacePointerGeometry";
import {
  applyBlockDragResolution,
  applyResolvedBlockDrag,
  resolveBlockDrag,
  resolveDragCursor,
  type BlockDragResolution,
} from "./workspaceBlockDragModel";

type UseWorkspaceBlockDragHandlersOptions = {
  currentChapter: ChapterSnapshot | null;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingToolActive: boolean;
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
  jobActive: boolean;
  regionSelectionActive: boolean;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  setSelectedBlockId: (blockId: string | null) => void;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  stageRef: RefObject<HTMLDivElement | null>;
  updateCurrentChapter: UpdateCurrentChapter;
};

type ActiveBlockDrag = {
  drag: DragState;
  latestValidResolution: BlockDragResolution | null;
  page: MangaPage;
  pointerRect: PointerRect;
  pointerChanged: boolean;
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
    previewStore.set({ blockPreview: null, dragHud: null });
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
  {
    imageRef,
    inpaintingToolActive,
    interactionPreviewStore,
    jobActive,
    regionSelectionActive,
    selectedPage,
    selectedPageEditLocked,
    setSelectedBlockId,
    setSelectedBlockIds,
    stageRef,
  }: UseWorkspaceBlockDragHandlersOptions,
  dragRef: BlockDragRef,
): (event: PointerEvent, block: TranslationBlock, mode: DragMode) => void {
  return useCallback(
    (event, block, mode) => {
      const stage = stageRef.current;
      if (
        !stage ||
        !selectedPage ||
        jobActive ||
        selectedPageEditLocked ||
        regionSelectionActive ||
        inpaintingToolActive
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
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
      setSelectedBlockIds((current) =>
        current.length === 1 && current[0] === block.id ? current : [block.id],
      );
      const pointerRect =
        imageRef.current?.getBoundingClientRect() ??
        stage.getBoundingClientRect();
      const activeDrag = startBlockDrag({
        block,
        event,
        mode,
        page: selectedPage,
        pointerRect,
      });
      dragRef.current = activeDrag;
      interactionPreviewStore.set({
        blockPreview: { block: activeDrag.drag.startBlock, blockId: block.id },
        dragHud: resolveInitialDragHud(activeDrag.drag, selectedPage),
      });
      stage.style.cursor = resolveDragCursor(mode);
      capturePointerSafely(stage, event.pointerId);
    },
    [
      dragRef,
      imageRef,
      inpaintingToolActive,
      interactionPreviewStore,
      jobActive,
      regionSelectionActive,
      selectedPage,
      selectedPageEditLocked,
      setSelectedBlockId,
      setSelectedBlockIds,
      stageRef,
    ],
  );
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
      );
      if (!resolution) return;
      active.pointerChanged ||= hasPointerChanged(active.drag, event);
      const dragHud = resolveBlockDragHud(resolution, active.drag.mode, {
        invalidCurve: tComponents("transform.hud.invalidCurve"),
        invalidPerspective: tComponents("transform.hud.invalidPerspective"),
        outsidePage: tComponents("transform.hud.outsidePage"),
        snapped: tComponents("transform.hud.snapped"),
      });
      if (resolution.invalid) {
        interactionPreviewStore.queue({ dragHud });
        return;
      }
      active.latestValidResolution = resolution;
      interactionPreviewStore.queue({
        blockPreview: {
          block: applyBlockDragResolution(
            active.drag.startBlock,
            active.page,
            resolution,
          ),
          blockId: active.drag.blockId,
        },
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
              ),
            {
              label: t("workspaceHistory.dragBlock"),
              mergeKey: `drag:${active.drag.blockId}`,
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

function startBlockDrag({
  block,
  event,
  mode,
  page,
  pointerRect,
}: {
  block: TranslationBlock;
  event: PointerEvent;
  mode: DragMode;
  page: MangaPage;
  pointerRect: PointerRect;
}): ActiveBlockDrag {
  const pageSize = { width: page.width, height: page.height };
  const displayText = block.translatedText || block.sourceText || "...";
  const target = resolveEditableBlockBbox(block, pageSize, displayText);
  return {
    drag: {
      mode,
      blockId: block.id,
      startX: event.clientX,
      startY: event.clientY,
      startBbox: target.bbox,
      startBlock: block,
      pointerId: event.pointerId,
    },
    latestValidResolution: null,
    page,
    pointerChanged: false,
    pointerRect,
  };
}

function resolveInitialDragHud(drag: DragState, page: MangaPage): DragHud {
  return {
    mode: drag.mode,
    label:
      drag.mode === "rotate"
        ? `${drag.startBlock.rotationDeg ?? 0}°`
        : describeDragBbox(drag.mode, drag.startBbox, page),
  };
}

function hasPointerChanged(
  drag: DragState,
  event: Pick<PointerEvent, "clientX" | "clientY">,
): boolean {
  return event.clientX !== drag.startX || event.clientY !== drag.startY;
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
