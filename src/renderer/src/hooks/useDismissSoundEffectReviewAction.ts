import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { libraryGateway } from "../api/libraryGateway";
import type {
  ApplyChapterAction,
  UseLibraryActionsOptions,
} from "./libraryActionTypes";
import { formatTranslationActionError } from "./translationActionUtils";

type Options = Pick<
  UseLibraryActionsOptions,
  "currentChapter" | "dirty" | "pushStatus" | "saveNow"
> & {
  applyChapter: ApplyChapterAction;
};

export function useDismissSoundEffectReviewAction({
  applyChapter,
  currentChapter,
  dirty,
  pushStatus,
  saveNow,
}: Options): (pageId: string, regionId: string) => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (pageId, regionId) => {
      if (!currentChapter) return;
      try {
        if (dirty) await saveNow();
        const chapter = await libraryGateway.dismissSoundEffectReviewRegion(
          currentChapter.id,
          pageId,
          regionId,
        );
        applyChapter(chapter);
        pushStatus(t("soundEffectReview.dismissed"));
      } catch (error) {
        pushStatus(
          formatTranslationActionError(
            error,
            t("soundEffectReview.dismissFailed"),
          ),
        );
      }
    },
    [applyChapter, currentChapter, dirty, pushStatus, saveNow, t],
  );
}
