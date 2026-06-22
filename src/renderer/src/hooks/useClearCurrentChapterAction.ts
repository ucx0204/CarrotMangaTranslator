import { useCallback } from "react";
import type { UseLibraryActionsOptions } from "./libraryActionTypes";

type ClearCurrentChapterOptions = Pick<
  UseLibraryActionsOptions,
  | "clearDirtyTracking"
  | "currentChapterRef"
  | "resetSaveBaseline"
  | "setCurrentChapter"
  | "setSelectedBlockId"
  | "setSelectedPageId"
>;

export function useClearCurrentChapterAction({
  clearDirtyTracking,
  currentChapterRef,
  resetSaveBaseline,
  setCurrentChapter,
  setSelectedBlockId,
  setSelectedPageId,
}: ClearCurrentChapterOptions): () => void {
  return useCallback(() => {
    setCurrentChapter(null);
    currentChapterRef.current = null;
    setSelectedPageId(null);
    setSelectedBlockId(null);
    clearDirtyTracking();
    resetSaveBaseline(null);
  }, [
    clearDirtyTracking,
    currentChapterRef,
    resetSaveBaseline,
    setCurrentChapter,
    setSelectedBlockId,
    setSelectedPageId,
  ]);
}
