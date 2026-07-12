import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot, RunMode } from "../../../shared/libraryTypes";

type UsePageRetranslationActionOptions = {
  askConfirm: (
    title: string,
    message: string,
    detail?: string,
  ) => Promise<boolean>;
  currentChapter: ChapterSnapshot | null;
  openRetranslateOptions: (pageId: string) => void;
  runAnalysis: (runMode: RunMode, pageId?: string) => Promise<unknown>;
};

export function usePageRetranslationAction({
  askConfirm,
  currentChapter,
  openRetranslateOptions,
  runAnalysis,
}: UsePageRetranslationActionOptions): (pageId: string) => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (pageId) => {
      const page = currentChapter?.pages.find(
        (candidate) => candidate.id === pageId,
      );
      if (!page || !currentChapter) {
        return;
      }
      if (page.blocks.length > 0) {
        openRetranslateOptions(page.id);
        return;
      }
      const confirmed = await askConfirm(
        t("library.retranslate.title"),
        t("library.retranslate.confirm"),
        t("library.retranslate.detail"),
      );
      if (!confirmed) {
        return;
      }
      await runAnalysis("single-page", pageId);
    },
    [askConfirm, currentChapter, openRetranslateOptions, runAnalysis, t],
  );
}
