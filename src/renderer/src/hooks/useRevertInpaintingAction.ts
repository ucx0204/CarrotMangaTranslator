import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { mangaGateway } from "../api/mangaGateway";
import { formatErrorMessage } from "../lib/appHelpers";
import {
  failInpaintingJob,
  resolveInpaintingTarget,
  type InpaintingScope,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useRevertInpaintingAction({
  askConfirm,
  clearPageImageCache,
  clearRetouchHistory,
  currentChapter,
  jobActive,
  mergeLiveChapter,
  pushStatus,
  selectedPage,
  setJobState,
}: UseInpaintingActionsOptions): (scope: InpaintingScope) => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (scope) => {
      const target = resolveInpaintingTarget(
        currentChapter,
        selectedPage,
        scope,
      );
      if (!target || jobActive) {
        return;
      }
      const confirmed = await askConfirm(
        scope === "page"
          ? t("inpainting.revert.pageTitle")
          : t("inpainting.revert.chapterTitle"),
        scope === "page"
          ? t("inpainting.revert.pageMessage")
          : t("inpainting.revert.chapterMessage"),
        t("inpainting.revert.detail"),
      );
      if (!confirmed) {
        return;
      }
      try {
        const result = await mangaGateway.revertInpainting(
          target.pageId
            ? {
                chapterId: target.chapterId,
                scope: "page",
                pageId: target.pageId,
              }
            : { chapterId: target.chapterId, scope: "chapter" },
        );
        clearPageImageCache();
        mergeLiveChapter(result.chapter);
        clearRetouchHistory();
        pushStatus(
          t("inpainting.revert.success", { count: result.pagesChanged }),
        );
      } catch (error) {
        console.error(error);
        failInpaintingJob(
          setJobState,
          pushStatus,
          t("inpainting.revert.failedTitle"),
          formatErrorMessage(error, t("inpainting.revert.failed")),
        );
      }
    },
    [
      askConfirm,
      clearPageImageCache,
      clearRetouchHistory,
      currentChapter,
      jobActive,
      mergeLiveChapter,
      pushStatus,
      selectedPage,
      setJobState,
      t,
    ],
  );
}
