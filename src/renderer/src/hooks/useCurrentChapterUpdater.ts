import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ChapterSnapshot } from "../../../shared/types";

type UseCurrentChapterUpdaterOptions = {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  markDirty: (pageId?: string) => void;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
};

export type UpdateCurrentChapter = (pageId: string, updater: (chapter: ChapterSnapshot) => ChapterSnapshot) => void;

export function useCurrentChapterUpdater({
  currentChapterRef,
  markDirty,
  setCurrentChapter
}: UseCurrentChapterUpdaterOptions): UpdateCurrentChapter {
  return useCallback(
    (pageId, updater) => {
      setCurrentChapter((current) => {
        if (!current) {
          return current;
        }
        const next = updater(current);
        currentChapterRef.current = next;
        markDirty(pageId);
        return next;
      });
    },
    [currentChapterRef, markDirty, setCurrentChapter]
  );
}
