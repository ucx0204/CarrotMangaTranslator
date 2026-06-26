import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import {
  emptyHistory,
  recordHistory,
  redoHistory,
  undoHistory,
  type ChapterHistoryEntry,
} from "../lib/chapterHistoryStack";

export type RecordChapterChangeOptions = {
  /** Edits sharing a mergeKey within the coalescing window form one undo step. */
  mergeKey?: string;
};

export type ChapterHistory = {
  /** Capture the current chapter+selection as the pre-change snapshot. */
  recordChange: (options?: RecordChapterChangeOptions) => void;
  undo: () => boolean;
  redo: () => boolean;
  reset: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

type HistoryOp = typeof undoHistory;

type UseChapterHistoryOptions = {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  /** Identity of the open chapter; changing it clears the undo/redo stacks. */
  chapterId: string | null;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
  selectedPageId: string | null;
  selectedBlockId: string | null;
  selectedBlockIds: string[];
  setSelectedPageId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  markDirty: (pageId?: string) => void;
};

export function useChapterHistory(
  options: UseChapterHistoryOptions,
): ChapterHistory {
  const { currentChapterRef, chapterId } = options;
  const stateRef = useRef(emptyHistory<ChapterSnapshot>());
  const selectionRef = useRef(selectionOf(options));
  useEffect(() => {
    selectionRef.current = selectionOf(options);
  });

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const syncFlags = useCallback(() => {
    setCanUndo(stateRef.current.past.length > 0);
    setCanRedo(stateRef.current.future.length > 0);
  }, []);

  const reset = useCallback(() => {
    stateRef.current = emptyHistory();
    setCanUndo(false);
    setCanRedo(false);
  }, []);
  // A different (or no) chapter starts with a clean history.
  useEffect(() => reset(), [chapterId, reset]);

  const present = useCallback(
    (mergeKey?: string): ChapterHistoryEntry<ChapterSnapshot> | null => {
      const chapter = currentChapterRef.current;
      return chapter
        ? { chapter, ...selectionRef.current, mergeKey, time: Date.now() }
        : null;
    },
    [currentChapterRef],
  );

  const applyEntry = useCallback(
    (entry: ChapterHistoryEntry<ChapterSnapshot>) =>
      restoreHistoryEntry(entry, options),
    [options],
  );

  const recordChange = useCallback(
    (recordOptions?: RecordChapterChangeOptions) => {
      const snapshot = present(recordOptions?.mergeKey);
      if (!snapshot) {
        return;
      }
      stateRef.current = recordHistory(stateRef.current, snapshot, {
        mergeKey: recordOptions?.mergeKey,
      });
      syncFlags();
    },
    [present, syncFlags],
  );

  const runOp = useCallback(
    (op: HistoryOp): boolean => {
      const snapshot = present();
      if (!snapshot) {
        return false;
      }
      const result = op(stateRef.current, snapshot);
      if (!result) {
        return false;
      }
      stateRef.current = result.state;
      applyEntry(result.entry);
      syncFlags();
      return true;
    },
    [applyEntry, present, syncFlags],
  );

  const undo = useCallback(() => runOp(undoHistory), [runOp]);
  const redo = useCallback(() => runOp(redoHistory), [runOp]);

  return { recordChange, undo, redo, reset, canUndo, canRedo };
}

function selectionOf(options: UseChapterHistoryOptions): {
  selectedPageId: string | null;
  selectedBlockId: string | null;
  selectedBlockIds: string[];
} {
  return {
    selectedPageId: options.selectedPageId,
    selectedBlockId: options.selectedBlockId,
    selectedBlockIds: options.selectedBlockIds,
  };
}

function restoreHistoryEntry(
  entry: ChapterHistoryEntry<ChapterSnapshot>,
  options: UseChapterHistoryOptions,
): void {
  const previous = options.currentChapterRef.current;
  options.currentChapterRef.current = entry.chapter;
  options.setCurrentChapter(entry.chapter);
  options.setSelectedPageId(entry.selectedPageId);
  options.setSelectedBlockId(entry.selectedBlockId);
  options.setSelectedBlockIds(entry.selectedBlockIds);
  markChangedPagesDirty(previous, entry.chapter, options.markDirty);
}

function markChangedPagesDirty(
  previous: ChapterSnapshot | null,
  next: ChapterSnapshot,
  markDirty: (pageId?: string) => void,
): void {
  const previousById = new Map(
    (previous?.pages ?? []).map((page) => [page.id, page]),
  );
  for (const page of next.pages) {
    if (previousById.get(page.id) !== page) {
      markDirty(page.id);
    }
  }
}
