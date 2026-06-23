import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  clampBbox,
  normalizeBlockType,
  normalizeRenderDirection,
  normalizeRotationDeg,
  offsetBlockBboxes,
} from "../../../shared/geometry";
import {
  pickBlockFormat,
  type BlockFormatGroupId,
} from "../../../shared/blockFormat";

export type FormatApplyScope = "selection" | "page" | "chapter";

type UseBlockEditingActionsOptions = {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  jobActive: boolean;
  markDirty: (pageId?: string) => void;
  pushStatus: (line: string) => void;
  selectedBlock: TranslationBlock | null;
  selectedBlockIds: string[];
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  updateCurrentChapter: (
    pageId: string,
    updater: (chapter: ChapterSnapshot) => ChapterSnapshot,
  ) => void;
};

type BlockEditingActions = {
  applyFormatToScope: (
    scope: FormatApplyScope,
    groupIds: BlockFormatGroupId[],
  ) => void;
  deleteSelectedBlock: () => void;
  duplicateSelectedBlock: () => void;
  toggleBlockInpaintExcluded: (blockId: string) => void;
  updateSelectedBlock: (patch: Partial<TranslationBlock>) => void;
};

export function useBlockEditingActions(
  options: UseBlockEditingActionsOptions,
): BlockEditingActions {
  const updateSelectedBlock = useUpdateSelectedBlockAction(options);
  const toggleBlockInpaintExcluded =
    useToggleBlockInpaintExcludedAction(options);
  const applyFormatToScope = useApplyFormatToScopeAction(options);
  const deleteSelectedBlock = useDeleteSelectedBlockAction(options);
  const duplicateSelectedBlock = useDuplicateSelectedBlockAction(options);

  return {
    applyFormatToScope,
    deleteSelectedBlock,
    duplicateSelectedBlock,
    toggleBlockInpaintExcluded,
    updateSelectedBlock,
  };
}

function useUpdateSelectedBlockAction({
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["updateSelectedBlock"] {
  return useCallback(
    (patch: Partial<TranslationBlock>) => {
      if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
        return;
      }

      updateCurrentChapter(selectedPage.id, (current) => ({
        ...current,
        pages: current.pages.map((page) =>
          page.id !== selectedPage.id
            ? page
            : {
                ...page,
                updatedAt: new Date().toISOString(),
                blocks: page.blocks.map((block) => {
                  if (block.id !== selectedBlock.id) {
                    return block;
                  }

                  const nextType = normalizeBlockType(patch.type ?? block.type);
                  const nextRenderDirection = normalizeRenderDirection(
                    patch.renderDirection ?? block.renderDirection,
                    block.renderDirection,
                  );
                  return {
                    ...block,
                    ...patch,
                    type: nextType,
                    renderDirection: nextRenderDirection,
                    rotationDeg: normalizeRotationDeg(
                      patch.rotationDeg ?? block.rotationDeg ?? 0,
                    ),
                    backgroundColor:
                      patch.backgroundColor ?? block.backgroundColor,
                    opacity: patch.opacity ?? block.opacity,
                    bbox: patch.bbox ? clampBbox(patch.bbox) : block.bbox,
                    bboxSpace: patch.bbox ? "normalized_1000" : block.bboxSpace,
                    renderBbox: patch.renderBbox
                      ? clampBbox(patch.renderBbox)
                      : block.renderBbox,
                    renderBboxSpace: patch.renderBbox
                      ? "normalized_1000"
                      : block.renderBboxSpace,
                  };
                }),
              },
        ),
      }));
    },
    [selectedBlock, selectedPage, selectedPageEditLocked, updateCurrentChapter],
  );
}

function useToggleBlockInpaintExcludedAction({
  jobActive,
  selectedPage,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["toggleBlockInpaintExcluded"] {
  return useCallback(
    (blockId: string) => {
      if (!selectedPage || jobActive) {
        return;
      }
      updateCurrentChapter(selectedPage.id, (current) => ({
        ...current,
        pages: current.pages.map((page) =>
          page.id !== selectedPage.id
            ? page
            : {
                ...page,
                updatedAt: new Date().toISOString(),
                blocks: page.blocks.map((block) =>
                  block.id === blockId
                    ? { ...block, inpaintExcluded: !block.inpaintExcluded }
                    : block,
                ),
              },
        ),
      }));
    },
    [jobActive, selectedPage, updateCurrentChapter],
  );
}

function useApplyFormatToScopeAction({
  currentChapter,
  currentChapterRef,
  jobActive,
  markDirty,
  pushStatus,
  selectedBlock,
  selectedBlockIds,
  selectedPage,
  selectedPageEditLocked,
  setCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["applyFormatToScope"] {
  return useCallback(
    (scope: FormatApplyScope, groupIds: BlockFormatGroupId[]) => {
      if (
        !currentChapter ||
        !selectedBlock ||
        selectedPageEditLocked ||
        groupIds.length === 0
      ) {
        return;
      }
      if (scope === "chapter" && jobActive) {
        pushStatus(
          "작업 중에는 이 화 전체 서식 일괄 적용을 사용할 수 없습니다.",
        );
        return;
      }
      const targetPageIds = resolveFormatTargetPageIds(
        scope,
        currentChapter,
        selectedPage,
      );
      if (targetPageIds.length === 0) {
        return;
      }
      // For "selection" scope, only the multi-selected block ids are touched.
      const blockIdFilter =
        scope === "selection" ? new Set(selectedBlockIds) : null;
      const patch = pickBlockFormat(selectedBlock, groupIds);
      targetPageIds.forEach((id) => markDirty(id));
      const next = applyFormatToChapterPages(
        currentChapter,
        new Set(targetPageIds),
        blockIdFilter,
        patch,
      );
      currentChapterRef.current = next;
      setCurrentChapter(next);
      pushStatus(resolveFormatApplyStatus(scope, blockIdFilter?.size ?? 0));
    },
    [
      currentChapter,
      currentChapterRef,
      jobActive,
      markDirty,
      pushStatus,
      selectedBlock,
      selectedBlockIds,
      selectedPage,
      selectedPageEditLocked,
      setCurrentChapter,
    ],
  );
}

function resolveFormatTargetPageIds(
  scope: FormatApplyScope,
  currentChapter: ChapterSnapshot,
  selectedPage: MangaPage | null,
): string[] {
  if (scope === "chapter") {
    return currentChapter.pages.map((page) => page.id);
  }
  return selectedPage ? [selectedPage.id] : [];
}

function applyFormatToChapterPages(
  currentChapter: ChapterSnapshot,
  targetPageIds: Set<string>,
  blockIdFilter: Set<string> | null,
  patch: Partial<TranslationBlock>,
): ChapterSnapshot {
  const stamp = new Date().toISOString();
  return {
    ...currentChapter,
    pages: currentChapter.pages.map((page) =>
      targetPageIds.has(page.id)
        ? {
            ...page,
            updatedAt: stamp,
            blocks: page.blocks.map((block) =>
              blockIdFilter && !blockIdFilter.has(block.id)
                ? block
                : applyFormatPatchToBlock(block, patch),
            ),
          }
        : page,
    ),
  };
}

function applyFormatPatchToBlock(
  block: TranslationBlock,
  patch: Partial<TranslationBlock>,
): TranslationBlock {
  const next = { ...block, ...patch };
  if (patch.renderDirection !== undefined) {
    next.renderDirection = normalizeRenderDirection(
      patch.renderDirection,
      block.renderDirection,
    );
  }
  if (patch.rotationDeg !== undefined) {
    next.rotationDeg = normalizeRotationDeg(patch.rotationDeg);
  }
  return next;
}

function resolveFormatApplyStatus(
  scope: FormatApplyScope,
  selectionCount: number,
): string {
  if (scope === "selection") {
    return `선택한 블록 ${selectionCount}개에 서식을 적용했습니다.`;
  }
  if (scope === "page") {
    return "이 페이지의 모든 블록에 서식을 적용했습니다.";
  }
  return "이 화 전체 블록에 서식을 적용했습니다.";
}

function useDeleteSelectedBlockAction({
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  setSelectedBlockId,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["deleteSelectedBlock"] {
  return useCallback(() => {
    if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
      return;
    }
    updateCurrentChapter(selectedPage.id, (current) => ({
      ...current,
      pages: current.pages.map((page) =>
        page.id === selectedPage.id
          ? {
              ...page,
              updatedAt: new Date().toISOString(),
              blocks: page.blocks.filter(
                (block) => block.id !== selectedBlock.id,
              ),
            }
          : page,
      ),
    }));
    setSelectedBlockId(null);
  }, [
    selectedBlock,
    selectedPage,
    selectedPageEditLocked,
    setSelectedBlockId,
    updateCurrentChapter,
  ]);
}

function useDuplicateSelectedBlockAction({
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  setSelectedBlockId,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["duplicateSelectedBlock"] {
  return useCallback(() => {
    if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
      return;
    }
    const copy = {
      ...offsetBlockBboxes(selectedBlock, 16, 16, {
        width: selectedPage.width,
        height: selectedPage.height,
      }),
      id: `${selectedBlock.id}-copy-${Date.now()}`,
    };
    updateCurrentChapter(selectedPage.id, (current) => ({
      ...current,
      pages: current.pages.map((page) =>
        page.id === selectedPage.id
          ? {
              ...page,
              updatedAt: new Date().toISOString(),
              blocks: [...page.blocks, copy],
            }
          : page,
      ),
    }));
    setSelectedBlockId(copy.id);
  }, [
    selectedBlock,
    selectedPage,
    selectedPageEditLocked,
    setSelectedBlockId,
    updateCurrentChapter,
  ]);
}
