import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { RecordChapterChangeOptions } from "./useChapterHistory";

export type UpdateCurrentChapterOptions = {
  /** Coalescing key passed through to the undo history. */
  mergeKey?: string;
  /** Background/live updates set this so they are not recorded as undo steps. */
  skipHistory?: boolean;
};

type UseCurrentChapterUpdaterOptions = {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  markDirty: (pageId?: string) => void;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
  recordChange: (options?: RecordChapterChangeOptions) => void;
};

export type UpdateCurrentChapter = (
  pageId: string,
  updater: (chapter: ChapterSnapshot) => ChapterSnapshot,
  options?: UpdateCurrentChapterOptions,
) => void;

export function useCurrentChapterUpdater({
  currentChapterRef,
  markDirty,
  setCurrentChapter,
  recordChange,
}: UseCurrentChapterUpdaterOptions): UpdateCurrentChapter {
  return useCallback(
    (pageId, updater, options) => {
      const current = currentChapterRef.current;
      if (!current) {
        return;
      }

      // Snapshot the pre-change chapter before mutating so undo can restore it.
      if (!options?.skipHistory) {
        recordChange({ mergeKey: options?.mergeKey });
      }
      markDirty(pageId);
      const next = updater(current);
      currentChapterRef.current = next;
      setCurrentChapter(next);
    },
    [currentChapterRef, markDirty, recordChange, setCurrentChapter],
  );
}
