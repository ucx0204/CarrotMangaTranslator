import { useCallback } from "react";
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
        "페이지 삭제",
        "정말 삭제하시겠습니까?",
        "이 페이지와 해당 번역 결과가 보관함에서 삭제됩니다.",
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
        pushStatus(`${page.name} 페이지를 삭제했습니다.`);
        await refreshLibrary();
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, "페이지를 삭제하지 못했습니다."));
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
    ],
  );
}
