import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import { useFonts } from "../fonts/useFonts";
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
  const { catalog } = useFonts();
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
          adjustBlockFontSizeInChapter(
            current,
            pageId,
            blockId,
            adjustment,
            catalog,
          ),
        {
          label: t("workspaceHistory.blockEdit"),
          mergeKey: `style:${blockId}`,
        },
      );
    },
    [
      catalog,
      selectedBlock,
      selectedPage,
      selectedPageEditLocked,
      t,
      updateCurrentChapter,
    ],
  );
}
