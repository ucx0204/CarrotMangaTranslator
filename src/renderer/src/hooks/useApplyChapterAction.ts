import { useCallback } from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type {
  ApplyChapterAction,
  UseLibraryActionsOptions,
} from "./libraryActionTypes";

type ApplyChapterOptions = Pick<
  UseLibraryActionsOptions,
  | "clearDirtyTracking"
  | "currentChapterRef"
  | "pushStatus"
  | "resetSaveBaseline"
  | "setCurrentChapter"
  | "setSelectedBlockId"
  | "setSelectedPageId"
>;

function resolveSelectedPageIdAfterApply(
  chapter: ChapterSnapshot,
  currentPageId: string | null,
): string | null {
  return chapter.pages.some((page) => page.id === currentPageId)
    ? currentPageId
    : (chapter.pages[0]?.id ?? null);
}

export function useApplyChapterAction({
  clearDirtyTracking,
  currentChapterRef,
  pushStatus,
  resetSaveBaseline,
  setCurrentChapter,
  setSelectedBlockId,
  setSelectedPageId,
}: ApplyChapterOptions): ApplyChapterAction {
  return useCallback(
    (chapter, fallbackStatus) => {
      if (!chapter) {
        return;
      }
      clearDirtyTracking();
      currentChapterRef.current = chapter;
      resetSaveBaseline(chapter);
      setCurrentChapter(chapter);
      setSelectedPageId((current) =>
        resolveSelectedPageIdAfterApply(chapter, current),
      );
      setSelectedBlockId(null);
      if (fallbackStatus) {
        pushStatus(fallbackStatus);
      }
    },
    [
      clearDirtyTracking,
      currentChapterRef,
      pushStatus,
      resetSaveBaseline,
      setCurrentChapter,
      setSelectedBlockId,
      setSelectedPageId,
    ],
  );
}
