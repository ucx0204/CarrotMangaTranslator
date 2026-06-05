import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ChapterSnapshot } from "../../../shared/types";
import { mergeLiveChapterPreservingDirtyPages, resolveSelectionAfterChapterSync } from "../lib/chapterSync";

type UseLiveChapterSyncOptions = {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  dirtyPageIdsRef: MutableRefObject<Set<string>>;
  replaceDirtyPageIds: (pageIds: string[]) => void;
  selectedBlockId: string | null;
  selectedBlockIdRef: MutableRefObject<string | null>;
  selectedPageId: string | null;
  selectedPageIdRef: MutableRefObject<string | null>;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setSelectedPageId: Dispatch<SetStateAction<string | null>>;
};

export function useLiveChapterSync({
  currentChapter,
  currentChapterRef,
  dirtyPageIdsRef,
  replaceDirtyPageIds,
  selectedBlockId,
  selectedBlockIdRef,
  selectedPageId,
  selectedPageIdRef,
  setCurrentChapter,
  setSelectedBlockId,
  setSelectedPageId
}: UseLiveChapterSyncOptions): (chapter: ChapterSnapshot) => void {
  useEffect(() => {
    currentChapterRef.current = currentChapter;
  }, [currentChapter, currentChapterRef]);

  useEffect(() => {
    selectedPageIdRef.current = selectedPageId;
  }, [selectedPageId, selectedPageIdRef]);

  useEffect(() => {
    selectedBlockIdRef.current = selectedBlockId;
  }, [selectedBlockId, selectedBlockIdRef]);

  return useCallback(
    (chapter: ChapterSnapshot) => {
      const current = currentChapterRef.current;
      if (current && current.id !== chapter.id) {
        return;
      }

      const mergeResult = mergeLiveChapterPreservingDirtyPages(chapter, current, dirtyPageIdsRef.current);
      replaceDirtyPageIds(mergeResult.preservedDirtyPageIds);
      currentChapterRef.current = mergeResult.chapter;

      setCurrentChapter((currentChapter) => {
        if (currentChapter && currentChapter.id !== mergeResult.chapter.id) {
          return currentChapter;
        }
        return mergeResult.chapter;
      });

      const selection = resolveSelectionAfterChapterSync(mergeResult.chapter, selectedPageIdRef.current, selectedBlockIdRef.current);
      setSelectedPageId(selection.selectedPageId);
      setSelectedBlockId(selection.selectedBlockId);
    },
    [
      currentChapterRef,
      dirtyPageIdsRef,
      replaceDirtyPageIds,
      selectedBlockIdRef,
      selectedPageIdRef,
      setCurrentChapter,
      setSelectedBlockId,
      setSelectedPageId
    ]
  );
}
