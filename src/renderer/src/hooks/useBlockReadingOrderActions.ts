import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { offsetBlockBboxes } from "../../../shared/geometry";
import {
  inferPageBlockOrder,
  resolvePageBlockOrder,
} from "../../../shared/blockReadingOrder";
import { normalizeTranslationBlockPatch } from "./useUpdateSelectedBlockAction";
import {
  instantiateBlockLibraryEntry,
  type BlockLibraryEntryV1,
} from "../../../shared/blockLibrary";
import type {
  BlockEditingActions,
  UseBlockEditingActionsOptions,
} from "./blockEditingActionTypes";

export function useMoveSelectedBlockInReadingOrderAction({
  readingDirection = "rtl",
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["moveSelectedBlockInReadingOrder"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    (direction, blockId) => {
      const targetBlockId = blockId ?? selectedBlock?.id;
      if (!selectedPage || !targetBlockId || selectedPageEditLocked) return;
      const order = resolvePageBlockOrder(selectedPage, readingDirection);
      const index = order.indexOf(targetBlockId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= order.length) return;
      const currentId = order[index];
      const targetId = order[target];
      if (!currentId || !targetId) return;
      order[index] = targetId;
      order[target] = currentId;
      updateCurrentChapter(
        selectedPage.id,
        (current) => ({
          ...current,
          pages: current.pages.map((page) =>
            page.id === selectedPage.id
              ? {
                  ...page,
                  blockOrder: order,
                  updatedAt: new Date().toISOString(),
                }
              : page,
          ),
        }),
        { label: t("workspaceHistory.readingOrder") },
      );
    },
    [
      readingDirection,
      selectedBlock,
      selectedPage,
      selectedPageEditLocked,
      t,
      updateCurrentChapter,
    ],
  );
}

export function useSortPageReadingOrderAction({
  readingDirection = "rtl",
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["sortPageReadingOrder"] {
  const { t } = useTranslation("renderer");
  return useCallback(() => {
    if (!selectedPage || selectedPageEditLocked) return;
    const order = inferPageBlockOrder(selectedPage.blocks, readingDirection);
    updateCurrentChapter(
      selectedPage.id,
      (current) => ({
        ...current,
        pages: current.pages.map((page) =>
          page.id === selectedPage.id
            ? {
                ...page,
                blockOrder: order,
                updatedAt: new Date().toISOString(),
              }
            : page,
        ),
      }),
      { label: t("workspaceHistory.readingOrder") },
    );
  }, [
    readingDirection,
    selectedPage,
    selectedPageEditLocked,
    t,
    updateCurrentChapter,
  ]);
}

export function useUpdateSelectedBlocksAction({
  selectedBlock,
  selectedBlockIds,
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["updateSelectedBlocks"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    (patch) => {
      if (!selectedPage || !selectedBlock || selectedPageEditLocked) return;
      const selectedIds = new Set(
        selectedBlockIds.length > 0 ? selectedBlockIds : [selectedBlock.id],
      );
      updateCurrentChapter(
        selectedPage.id,
        (current) => {
          let changed = false;
          const pages = current.pages.map((page) => {
            if (page.id !== selectedPage.id) return page;
            const blocks = page.blocks.map((block) => {
              if (!selectedIds.has(block.id)) return block;
              const next = normalizeTranslationBlockPatch(block, patch, {
                width: page.width,
                height: page.height,
              });
              changed ||= next !== block;
              return next;
            });
            return changed
              ? { ...page, blocks, updatedAt: new Date().toISOString() }
              : page;
          });
          return changed ? { ...current, pages } : current;
        },
        { label: t("workspaceHistory.blockEdit") },
      );
    },
    [
      selectedBlock,
      selectedBlockIds,
      selectedPage,
      selectedPageEditLocked,
      t,
      updateCurrentChapter,
    ],
  );
}

export function useDeleteSelectedBlockAction({
  selectedBlock,
  selectedBlockIds,
  selectedPage,
  selectedPageEditLocked,
  readingDirection = "rtl",
  setSelectedBlockId,
  setSelectedBlockIds,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["deleteSelectedBlock"] {
  const { t } = useTranslation("renderer");
  return useCallback(() => {
    if (!selectedPage || !selectedBlock || selectedPageEditLocked) return;
    const selectedIds = new Set(
      selectedBlockIds.length > 0 ? selectedBlockIds : [selectedBlock.id],
    );
    const currentOrder = resolvePageBlockOrder(selectedPage, readingDirection);
    const firstSelectedIndex = currentOrder.findIndex((id) =>
      selectedIds.has(id),
    );
    const nextOrder = currentOrder.filter((id) => !selectedIds.has(id));
    const predecessor = findDeletionNeighbor(
      currentOrder,
      selectedIds,
      firstSelectedIndex,
    );
    updateCurrentChapter(
      selectedPage.id,
      (current) => ({
        ...current,
        pages: current.pages.map((page) =>
          page.id === selectedPage.id
            ? {
                ...page,
                updatedAt: new Date().toISOString(),
                blocks: page.blocks.filter(
                  (block) => !selectedIds.has(block.id),
                ),
                blockOrder: nextOrder,
              }
            : page,
        ),
      }),
      {
        label: t("workspaceHistory.deleteBlock"),
        selectionAfter: {
          selectedPageId: selectedPage.id,
          selectedBlockId: predecessor,
          selectedBlockIds: predecessor ? [predecessor] : [],
        },
      },
    );
    setSelectedBlockId(predecessor);
    setSelectedBlockIds(predecessor ? [predecessor] : []);
  }, [
    selectedBlock,
    selectedBlockIds,
    selectedPage,
    selectedPageEditLocked,
    readingDirection,
    setSelectedBlockId,
    setSelectedBlockIds,
    t,
    updateCurrentChapter,
  ]);
}

function findDeletionNeighbor(
  order: readonly string[],
  selectedIds: ReadonlySet<string>,
  firstSelectedIndex: number,
): string | null {
  for (let index = firstSelectedIndex - 1; index >= 0; index -= 1) {
    const id = order[index];
    if (id && !selectedIds.has(id)) return id;
  }
  for (
    let index = Math.max(0, firstSelectedIndex);
    index < order.length;
    index += 1
  ) {
    const id = order[index];
    if (id && !selectedIds.has(id)) return id;
  }
  return null;
}

export function useDuplicateSelectedBlockAction({
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  readingDirection = "rtl",
  setSelectedBlockId,
  setSelectedBlockIds,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["duplicateSelectedBlock"] {
  const { t } = useTranslation("renderer");
  return useCallback(() => {
    if (!selectedPage || !selectedBlock || selectedPageEditLocked) return;
    const copy = {
      ...offsetBlockBboxes(selectedBlock, 16, 16, {
        width: selectedPage.width,
        height: selectedPage.height,
      }),
      id: `${selectedBlock.id}-copy-${Date.now()}`,
    };
    const blockOrder = resolvePageBlockOrder(selectedPage, readingDirection);
    const sourceIndex = blockOrder.indexOf(selectedBlock.id);
    blockOrder.splice(
      sourceIndex < 0 ? blockOrder.length : sourceIndex + 1,
      0,
      copy.id,
    );
    updateCurrentChapter(
      selectedPage.id,
      (current) => ({
        ...current,
        pages: current.pages.map((page) =>
          page.id === selectedPage.id
            ? {
                ...page,
                updatedAt: new Date().toISOString(),
                blocks: [...page.blocks, copy],
                blockOrder,
              }
            : page,
        ),
      }),
      {
        label: t("workspaceHistory.duplicateBlock"),
        selectionAfter: {
          selectedPageId: selectedPage.id,
          selectedBlockId: copy.id,
          selectedBlockIds: [copy.id],
        },
      },
    );
    setSelectedBlockId(copy.id);
    setSelectedBlockIds([copy.id]);
  }, [
    selectedBlock,
    selectedPage,
    selectedPageEditLocked,
    readingDirection,
    setSelectedBlockId,
    setSelectedBlockIds,
    t,
    updateCurrentChapter,
  ]);
}

export function useInsertBlockLibraryEntryAction({
  selectedPage,
  selectedPageEditLocked,
  readingDirection = "rtl",
  stageRef,
  setSelectedBlockId,
  setSelectedBlockIds,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["insertBlockLibraryEntry"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    (entry: BlockLibraryEntryV1) => {
      if (!selectedPage || selectedPageEditLocked) return;
      const id = createLibraryBlockId(selectedPage.id);
      const block = instantiateBlockLibraryEntry(
        entry,
        id,
        resolveVisibleStageCenter(stageRef?.current ?? null),
      );
      const blockOrder = resolvePageBlockOrder(selectedPage, readingDirection);
      blockOrder.push(id);
      updateCurrentChapter(
        selectedPage.id,
        (current) => ({
          ...current,
          pages: current.pages.map((page) =>
            page.id === selectedPage.id
              ? {
                  ...page,
                  updatedAt: new Date().toISOString(),
                  blocks: [...page.blocks, block],
                  blockOrder,
                }
              : page,
          ),
        }),
        {
          label: t("workspaceHistory.insertLibraryBlock"),
          selectionAfter: {
            selectedPageId: selectedPage.id,
            selectedBlockId: id,
            selectedBlockIds: [id],
          },
        },
      );
      setSelectedBlockId(id);
      setSelectedBlockIds([id]);
    },
    [
      readingDirection,
      selectedPage,
      selectedPageEditLocked,
      stageRef,
      setSelectedBlockId,
      setSelectedBlockIds,
      t,
      updateCurrentChapter,
    ],
  );
}

export function resolveVisibleStageCenter(stage: HTMLElement | null): {
  x: number;
  y: number;
} {
  if (!stage) return { x: 500, y: 500 };
  const stageRect = stage.getBoundingClientRect();
  if (stageRect.width <= 0 || stageRect.height <= 0) {
    return { x: 500, y: 500 };
  }
  const viewport = stage.closest<HTMLElement>(".workspace");
  const viewportRect = viewport?.getBoundingClientRect() ?? {
    left: 0,
    top: 0,
    right: globalThis.innerWidth,
    bottom: globalThis.innerHeight,
  };
  const left = Math.max(stageRect.left, viewportRect.left);
  const right = Math.min(stageRect.right, viewportRect.right);
  const top = Math.max(stageRect.top, viewportRect.top);
  const bottom = Math.min(stageRect.bottom, viewportRect.bottom);
  if (right <= left || bottom <= top) return { x: 500, y: 500 };
  return {
    x: clampNormalized(
      (((left + right) / 2 - stageRect.left) / stageRect.width) * 1000,
    ),
    y: clampNormalized(
      (((top + bottom) / 2 - stageRect.top) / stageRect.height) * 1000,
    ),
  };
}

function clampNormalized(value: number): number {
  return Math.min(1000, Math.max(0, value));
}

function createLibraryBlockId(pageId: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
  const separator = "-library-";
  const prefixLength = Math.max(1, 200 - separator.length - suffix.length);
  return `${pageId.slice(0, prefixLength)}${separator}${suffix}`;
}
