import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  nudgeBlockByImagePixels,
  resolveSharedBlockNudgeDeltaPx,
} from "../lib/blockKeyboardNudge";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";

type UseNudgeSelectedBlocksActionOptions = {
  jobActive: boolean;
  selectedBlock: TranslationBlock | null;
  selectedBlockIds: string[];
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  updateCurrentChapter: UpdateCurrentChapter;
};

export function useNudgeSelectedBlocksAction({
  jobActive,
  selectedBlock,
  selectedBlockIds,
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: UseNudgeSelectedBlocksActionOptions): (deltaPx: {
  x: number;
  y: number;
}) => void {
  const { t } = useTranslation("renderer");
  return useCallback(
    (deltaPx) => {
      if (
        !selectedPage ||
        !selectedBlock ||
        jobActive ||
        selectedPageEditLocked
      ) {
        return;
      }
      const selectedIds = new Set(
        selectedBlockIds.length > 0 ? selectedBlockIds : [selectedBlock.id],
      );
      const mergeKey = `nudge:${selectedPage.id}:${[...selectedIds]
        .sort()
        .join(",")}`;
      updateCurrentChapter(
        selectedPage.id,
        (current) => {
          let changed = false;
          const pages = current.pages.map((page) => {
            if (page.id !== selectedPage.id) {
              return page;
            }
            const sharedDeltaPx = resolveSharedBlockNudgeDeltaPx(
              page.blocks.filter((block) => selectedIds.has(block.id)),
              page,
              deltaPx,
            );
            const blocks = page.blocks.map((block) => {
              if (!selectedIds.has(block.id)) {
                return block;
              }
              const next = nudgeBlockByImagePixels(block, page, sharedDeltaPx);
              changed ||= next !== block;
              return next;
            });
            return changed
              ? { ...page, blocks, updatedAt: new Date().toISOString() }
              : page;
          });
          return changed ? { ...current, pages } : current;
        },
        {
          label: t("workspaceHistory.dragBlock"),
          mergeKey,
        },
      );
    },
    [
      jobActive,
      selectedBlock,
      selectedBlockIds,
      selectedPage,
      selectedPageEditLocked,
      t,
      updateCurrentChapter,
    ],
  );
}
