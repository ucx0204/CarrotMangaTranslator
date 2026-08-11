import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  pickBlockFormat,
  type BlockFormatGroupId,
} from "../../../shared/blockFormat";
import {
  resolveFormatApplyStatus,
  type FormatApplyScope,
} from "./blockEditingStatus";
import { useAdjustSelectedBlockFontSizeAction } from "./useAdjustSelectedBlockFontSizeAction";
import { useUpdateBlockAction } from "./useUpdateSelectedBlockAction";
import { useApplyBlockBackgroundOpacityAction } from "./useApplyBlockBackgroundOpacityAction";
import { useNudgeSelectedBlocksAction } from "./useNudgeSelectedBlocksAction";
import type { BlockStylePreset } from "../../../shared/blockStylePresets";
import { summarizeBlockStylePresets } from "../../../shared/blockStylePresets";
import { useApplyStylePresetAction } from "./useApplyStylePresetAction";
import { applyFormatToChapterPages } from "../lib/blockFormatApply";
import type {
  BlockEditingActions,
  UseBlockEditingActionsOptions,
} from "./blockEditingActionTypes";
import {
  useDeleteSelectedBlockAction,
  useDuplicateSelectedBlockAction,
  useMoveSelectedBlockInReadingOrderAction,
  useSortPageReadingOrderAction,
  useUpdateSelectedBlocksAction,
} from "./useBlockReadingOrderActions";

const EMPTY_FONT_IDS: ReadonlySet<string> = new Set();
const EMPTY_STYLE_PRESETS: readonly BlockStylePreset[] = [];

export function useBlockEditingActions(
  options: UseBlockEditingActionsOptions,
): BlockEditingActions {
  const adjustSelectedBlockFontSize =
    useAdjustSelectedBlockFontSizeAction(options);
  const updateBlock = useUpdateBlockAction(options);
  const updateSelectedBlock = useCallback(
    (patch: Partial<TranslationBlock>) => {
      if (options.selectedBlock) {
        updateBlock(options.selectedBlock.id, patch);
      }
    },
    [options.selectedBlock, updateBlock],
  );
  const updateSelectedBlocks = useUpdateSelectedBlocksAction(options);
  const toggleBlockInpaintExcluded =
    useToggleBlockInpaintExcludedAction(options);
  const applyBlockBackgroundOpacityToScope =
    useApplyBlockBackgroundOpacityAction(options);
  const applyFormatToScope = useApplyFormatToScopeAction(options);
  const applyStylePreset = useApplyStylePresetAction(options);
  const deleteSelectedBlock = useDeleteSelectedBlockAction(options);
  const duplicateSelectedBlock = useDuplicateSelectedBlockAction(options);
  const moveSelectedBlockInReadingOrder =
    useMoveSelectedBlockInReadingOrderAction(options);
  const sortPageReadingOrder = useSortPageReadingOrderAction(options);
  const removeSelectedBlockBubbleLayout =
    useRemoveSelectedBlockBubbleLayoutAction(options);
  const nudgeSelectedBlocks = useNudgeSelectedBlocksAction(options);
  const stylePresetSummaries = useMemo(
    () =>
      summarizeBlockStylePresets(
        options.blockStylePresets ?? EMPTY_STYLE_PRESETS,
        options.availableFontIds ?? EMPTY_FONT_IDS,
      ),
    [options.availableFontIds, options.blockStylePresets],
  );

  return {
    adjustSelectedBlockFontSize,
    applyBlockBackgroundOpacityToScope,
    applyFormatToScope,
    applyStylePreset,
    deleteSelectedBlock,
    duplicateSelectedBlock,
    moveSelectedBlockInReadingOrder,
    nudgeSelectedBlocks,
    removeSelectedBlockBubbleLayout,
    toggleBlockInpaintExcluded,
    updateBlock,
    updateSelectedBlock,
    updateSelectedBlocks,
    stylePresetSummaries,
    sortPageReadingOrder,
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
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["toggleBlockInpaintExcluded"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    (blockId: string) => {
      if (!selectedPage || selectedPageEditLocked) {
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
    [selectedPage, selectedPageEditLocked, t, updateCurrentChapter],
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
