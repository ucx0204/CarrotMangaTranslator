import { useCallback } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("renderer");
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
        pushStatus(formatErrorMessage(error, t("library.openChapterFailed")));
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
      t,
    ],
  );
}
