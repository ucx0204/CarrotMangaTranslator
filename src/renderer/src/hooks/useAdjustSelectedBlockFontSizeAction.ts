import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  adjustBlockFontSizeInChapter,
  type FontSizeAdjustment,
} from "../lib/blockFontSizeAdjustment";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";

type AdjustSelectedBlockFontSizeOptions = {
  selectedBlock: TranslationBlock | null;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  updateCurrentChapter: UpdateCurrentChapter;
};

export function useAdjustSelectedBlockFontSizeAction({
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: AdjustSelectedBlockFontSizeOptions): (
  adjustment: FontSizeAdjustment,
) => void {
  const { t } = useTranslation("renderer");
  return useCallback(
    (adjustment: FontSizeAdjustment) => {
      if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
        return;
      }
      const pageId = selectedPage.id;
      const blockId = selectedBlock.id;
      updateCurrentChapter(
        pageId,
        (current) =>
          adjustBlockFontSizeInChapter(current, pageId, blockId, adjustment),
        {
          label: t("workspaceHistory.blockEdit"),
          mergeKey: `style:${blockId}`,
        },
      );
    },
    [
      selectedBlock,
      selectedPage,
      selectedPageEditLocked,
      t,
      updateCurrentChapter,
    ],
  );
}
