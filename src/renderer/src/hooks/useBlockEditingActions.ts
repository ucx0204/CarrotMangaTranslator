import { useCallback, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  normalizeRenderDirection,
  normalizeRotationDeg,
  offsetBlockBboxes,
} from "../../../shared/geometry";
import {
  pickBlockFormat,
  type BlockFormatGroupId,
} from "../../../shared/blockFormat";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";
import {
  resolveFormatApplyStatus,
  type FormatApplyScope,
} from "./blockEditingStatus";
import type { FontSizeAdjustment } from "../lib/blockFontSizeAdjustment";
import { useAdjustSelectedBlockFontSizeAction } from "./useAdjustSelectedBlockFontSizeAction";
import { useUpdateSelectedBlockAction } from "./useUpdateSelectedBlockAction";
import {
  useApplyBlockBackgroundOpacityAction,
  type BlockBackgroundApplyScope,
} from "./useApplyBlockBackgroundOpacityAction";
import { useNudgeSelectedBlocksAction } from "./useNudgeSelectedBlocksAction";

type UseBlockEditingActionsOptions = {
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  pushStatus: (line: string) => void;
  selectedBlock: TranslationBlock | null;
  selectedBlockIds: string[];
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  updateCurrentChapter: UpdateCurrentChapter;
};

type BlockEditingActions = {
  adjustSelectedBlockFontSize: (adjustment: FontSizeAdjustment) => void;
  applyBlockBackgroundOpacityToScope: (
    scope: BlockBackgroundApplyScope,
  ) => void;
  applyFormatToScope: (
    scope: FormatApplyScope,
    groupIds: BlockFormatGroupId[],
  ) => void;
  deleteSelectedBlock: () => void;
  duplicateSelectedBlock: () => void;
  nudgeSelectedBlocks: (deltaPx: { x: number; y: number }) => void;
  removeSelectedBlockBubbleLayout: () => void;
  toggleBlockInpaintExcluded: (blockId: string) => void;
  updateSelectedBlock: (patch: Partial<TranslationBlock>) => void;
};

export function useBlockEditingActions(
  options: UseBlockEditingActionsOptions,
): BlockEditingActions {
  const adjustSelectedBlockFontSize =
    useAdjustSelectedBlockFontSizeAction(options);
  const updateSelectedBlock = useUpdateSelectedBlockAction(options);
  const toggleBlockInpaintExcluded =
    useToggleBlockInpaintExcludedAction(options);
  const applyBlockBackgroundOpacityToScope =
    useApplyBlockBackgroundOpacityAction(options);
  const applyFormatToScope = useApplyFormatToScopeAction(options);
  const deleteSelectedBlock = useDeleteSelectedBlockAction(options);
  const duplicateSelectedBlock = useDuplicateSelectedBlockAction(options);
  const removeSelectedBlockBubbleLayout =
    useRemoveSelectedBlockBubbleLayoutAction(options);
  const nudgeSelectedBlocks = useNudgeSelectedBlocksAction(options);

  return {
    adjustSelectedBlockFontSize,
    applyBlockBackgroundOpacityToScope,
    applyFormatToScope,
    deleteSelectedBlock,
    duplicateSelectedBlock,
    nudgeSelectedBlocks,
    removeSelectedBlockBubbleLayout,
    toggleBlockInpaintExcluded,
    updateSelectedBlock,
  };
}

function useRemoveSelectedBlockBubbleLayoutAction({
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["removeSelectedBlockBubbleLayout"] {
  const { t } = useTranslation("renderer");
  return useCallback(() => {
    if (
      !selectedPage ||
      !selectedBlock?.bubbleLayout ||
      selectedPageEditLocked
    ) {
      return;
    }
    updateCurrentChapter(
      selectedPage.id,
      (current) => {
        let changed = false;
        const pages = current.pages.map((page) => {
          if (page.id !== selectedPage.id) return page;
          const blocks = page.blocks.map((block) => {
            if (block.id !== selectedBlock.id || !block.bubbleLayout) {
              return block;
            }
            changed = true;
            const {
              bubbleLayout: _bubbleLayout,
              renderBbox: _renderBbox,
              renderBboxSpace: _renderBboxSpace,
              ...restoredBlock
            } = block;
            return restoredBlock;
          });
          return changed
            ? { ...page, blocks, updatedAt: new Date().toISOString() }
            : page;
        });
        return changed ? { ...current, pages } : current;
      },
      { label: t("workspaceHistory.removeBubbleLayout") },
    );
  }, [
    selectedBlock,
    selectedPage,
    selectedPageEditLocked,
    t,
    updateCurrentChapter,
  ]);
}

function useToggleBlockInpaintExcludedAction({
  jobActive,
  selectedPage,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["toggleBlockInpaintExcluded"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    (blockId: string) => {
      if (!selectedPage || jobActive) {
        return;
      }
      updateCurrentChapter(
        selectedPage.id,
        (current) => ({
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
        }),
        { label: t("workspaceHistory.exclusion") },
      );
    },
    [jobActive, selectedPage, t, updateCurrentChapter],
  );
}

function useApplyFormatToScopeAction({
  currentChapter,
  jobActive,
  pushStatus,
  selectedBlock,
  selectedBlockIds,
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["applyFormatToScope"] {
  const { t } = useTranslation("renderer");
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
        pushStatus(t("blockEditing.chapterApplyWhileRunning"));
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
      updateCurrentChapter(
        targetPageIds[0],
        (current) =>
          applyFormatToChapterPages(
            current,
            new Set(targetPageIds),
            blockIdFilter,
            patch,
          ),
        {
          dirtyPageIds: targetPageIds,
          label: t("workspaceHistory.format"),
        },
      );
      pushStatus(resolveFormatApplyStatus(scope, blockIdFilter?.size ?? 0, t));
    },
    [
      currentChapter,
      jobActive,
      pushStatus,
      selectedBlock,
      selectedBlockIds,
      selectedPage,
      selectedPageEditLocked,
      t,
      updateCurrentChapter,
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

function useDeleteSelectedBlockAction({
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  setSelectedBlockId,
  setSelectedBlockIds,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["deleteSelectedBlock"] {
  const { t } = useTranslation("renderer");
  return useCallback(() => {
    if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
      return;
    }
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
                  (block) => block.id !== selectedBlock.id,
                ),
              }
            : page,
        ),
      }),
      {
        label: t("workspaceHistory.deleteBlock"),
        selectionAfter: {
          selectedPageId: selectedPage.id,
          selectedBlockId: null,
          selectedBlockIds: [],
        },
      },
    );
    setSelectedBlockId(null);
    setSelectedBlockIds([]);
  }, [
    selectedBlock,
    selectedPage,
    selectedPageEditLocked,
    setSelectedBlockId,
    setSelectedBlockIds,
    t,
    updateCurrentChapter,
  ]);
}

function useDuplicateSelectedBlockAction({
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  setSelectedBlockId,
  setSelectedBlockIds,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["duplicateSelectedBlock"] {
  const { t } = useTranslation("renderer");
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
    setSelectedBlockId,
    setSelectedBlockIds,
    t,
    updateCurrentChapter,
  ]);
}
