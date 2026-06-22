import { useCallback } from "react";
import { formatErrorMessage } from "../lib/appHelpers";
import { libraryGateway } from "./libraryGateway";
import type { UseLibraryActionsOptions } from "./libraryActionTypes";

type OpenChapterOptions = Pick<
  UseLibraryActionsOptions,
  | "clearDirtyTracking"
  | "currentChapterRef"
  | "dirty"
  | "pushStatus"
  | "resetSaveBaseline"
  | "saveNow"
  | "setCurrentChapter"
  | "setSelectedBlockId"
  | "setSelectedPageId"
>;

export function useOpenChapterAction({
  clearDirtyTracking,
  currentChapterRef,
  dirty,
  pushStatus,
  resetSaveBaseline,
  saveNow,
  setCurrentChapter,
  setSelectedBlockId,
  setSelectedPageId,
}: OpenChapterOptions): (chapterId: string) => Promise<void> {
  return useCallback(
    async (chapterId) => {
      try {
        if (dirty) {
          await saveNow();
        }
        const chapter = await libraryGateway.openChapter(chapterId);
        clearDirtyTracking();
        currentChapterRef.current = chapter;
        resetSaveBaseline(chapter);
        setCurrentChapter(chapter);
        setSelectedPageId(chapter.pages[0]?.id ?? null);
        setSelectedBlockId(null);
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, "화를 열지 못했습니다."));
      }
    },
    [
      clearDirtyTracking,
      currentChapterRef,
      dirty,
      pushStatus,
      resetSaveBaseline,
      saveNow,
      setCurrentChapter,
      setSelectedBlockId,
      setSelectedPageId,
    ],
  );
}
