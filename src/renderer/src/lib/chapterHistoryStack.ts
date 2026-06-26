/**
 * Pure undo/redo stack for chapter edits. Kept free of React so the coalescing
 * and stack invariants can be unit-tested directly. Each entry captures the
 * chapter snapshot *and* the selection that was active for it, so undo/redo can
 * restore both.
 */

export const MAX_HISTORY_ENTRIES = 100;
export const HISTORY_COALESCE_MS = 600;

export type SelectionSnapshot = {
  selectedPageId: string | null;
  selectedBlockId: string | null;
  selectedBlockIds: string[];
};

export type ChapterHistoryEntry<TChapter> = SelectionSnapshot & {
  chapter: TChapter;
  mergeKey?: string;
  time: number;
};

export type ChapterHistoryState<TChapter> = {
  past: ChapterHistoryEntry<TChapter>[];
  future: ChapterHistoryEntry<TChapter>[];
};

export type RecordOptions = {
  mergeKey?: string;
  coalesceMs?: number;
  maxEntries?: number;
};

export function emptyHistory<TChapter>(): ChapterHistoryState<TChapter> {
  return { past: [], future: [] };
}

/**
 * Push the pre-change snapshot onto the past stack and clear the redo stack.
 * Consecutive changes sharing a `mergeKey` within the coalescing window collapse
 * into a single undo step (the original "before" snapshot is preserved).
 */
export function recordHistory<TChapter>(
  state: ChapterHistoryState<TChapter>,
  present: ChapterHistoryEntry<TChapter>,
  options: RecordOptions = {},
): ChapterHistoryState<TChapter> {
  const coalesceMs = options.coalesceMs ?? HISTORY_COALESCE_MS;
  const maxEntries = options.maxEntries ?? MAX_HISTORY_ENTRIES;
  const last = state.past.at(-1);

  if (
    last &&
    options.mergeKey != null &&
    last.mergeKey === options.mergeKey &&
    present.time - last.time < coalesceMs
  ) {
    // Coalesce: keep the earlier "before" snapshot, just extend its window.
    const past = state.past.slice(0, -1);
    past.push({ ...last, time: present.time });
    return { past, future: [] };
  }

  const past = [...state.past, present];
  const trimmed =
    past.length > maxEntries ? past.slice(past.length - maxEntries) : past;
  return { past: trimmed, future: [] };
}

export function undoHistory<TChapter>(
  state: ChapterHistoryState<TChapter>,
  present: ChapterHistoryEntry<TChapter>,
): {
  state: ChapterHistoryState<TChapter>;
  entry: ChapterHistoryEntry<TChapter>;
} | null {
  const entry = state.past.at(-1);
  if (!entry) {
    return null;
  }
  return {
    state: {
      past: state.past.slice(0, -1),
      future: [...state.future, present],
    },
    entry,
  };
}

export function redoHistory<TChapter>(
  state: ChapterHistoryState<TChapter>,
  present: ChapterHistoryEntry<TChapter>,
): {
  state: ChapterHistoryState<TChapter>;
  entry: ChapterHistoryEntry<TChapter>;
} | null {
  const entry = state.future.at(-1);
  if (!entry) {
    return null;
  }
  return {
    state: {
      past: [...state.past, present],
      future: state.future.slice(0, -1),
    },
    entry,
  };
}
