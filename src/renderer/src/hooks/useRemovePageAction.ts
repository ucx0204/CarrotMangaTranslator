import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { formatErrorMessage } from "../lib/appHelpers";
import { libraryGateway } from "./libraryGateway";
import type {
  ApplyChapterAction,
  ChapterSnapshot,
  UseLibraryActionsOptions,
} from "./libraryActionTypes";

type RemovePageActionOptions = Pick<
  UseLibraryActionsOptions,
  | "askConfirm"
  | "currentChapter"
  | "dirty"
  | "pushStatus"
  | "saveNow"
  | "setSelectedPageId"
> & {
  applyChapter: ApplyChapterAction;
  refreshLibrary: () => Promise<void>;
};

function resolvePageIdAfterRemoval(
  previousOrder: string[],
  removedPageId: string,
  nextChapter: ChapterSnapshot,
): string | null {
  const currentIndex = previousOrder.indexOf(removedPageId);
  const adjacentId =
    previousOrder[currentIndex + 1] ?? previousOrder[currentIndex - 1] ?? null;
  return adjacentId &&
    nextChapter.pages.some((candidate) => candidate.id === adjacentId)
    ? adjacentId
    : (nextChapter.pages[0]?.id ?? null);
}

export function useRemovePageAction({
  applyChapter,
  askConfirm,
  currentChapter,
  dirty,
  pushStatus,
  refreshLibrary,
  saveNow,
  setSelectedPageId,
}: RemovePageActionOptions): (pageId: string) => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (pageId) => {
      if (!currentChapter) {
        return;
      }
      const page = currentChapter.pages.find(
        (candidate) => candidate.id === pageId,
      );
      if (!page) {
        return;
      }
      const confirmed = await askConfirm(
        t("library.removePage.title"),
        t("library.removePage.confirm"),
        t("library.removePage.detail"),
      );
      if (!confirmed) {
        return;
      }

      try {
        if (dirty) {
          await saveNow();
        }
        const previousOrder = currentChapter.pages.map(
          (candidate) => candidate.id,
        );
        const nextChapter = await libraryGateway.deletePage(
          currentChapter.id,
          pageId,
        );
        applyChapter(nextChapter);
        setSelectedPageId(
          resolvePageIdAfterRemoval(previousOrder, pageId, nextChapter),
        );
        pushStatus(t("library.removePage.success", { name: page.name }));
        await refreshLibrary();
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, t("library.removePage.failed")));
      }
    },
    [
      applyChapter,
      askConfirm,
      currentChapter,
      dirty,
      pushStatus,
      refreshLibrary,
      saveNow,
      setSelectedPageId,
      t,
    ],
  );
}
