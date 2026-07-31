import type { InpaintingMaskStroke } from "../../../shared/inpaintingTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";

const WORKSPACE_HISTORY_MAX_ENTRIES = 60;
const WORKSPACE_HISTORY_COALESCE_MS = 600;

export type WorkspaceHistoryDirection = "undo" | "redo";
export type WorkspaceHistoryApplyOutcome = "applied" | "invalidated";

export type WorkspaceSelectionSnapshot = {
  selectedPageId: string | null;
  selectedBlockId: string | null;
  selectedBlockIds: string[];
};

type WorkspaceChapterPageSnapshot = {
  pageId: string;
  blocks: TranslationBlock[];
};

/**
 * The editable part of a chapter. Deliberately excludes image paths, analysis
 * state and every other page/chapter field which may be updated by a job while
 * the user edits text.
 */
export type WorkspaceChapterEditSnapshot = WorkspaceSelectionSnapshot & {
  chapterId: string;
  pages: WorkspaceChapterPageSnapshot[];
};

export type WorkspaceMaskSnapshot = {
  chapterId: string;
  pageId: string;
  strokes: InpaintingMaskStroke[];
};

type WorkspaceHistoryEntryBase = {
  id: string;
  label: string;
  mergeKey?: string;
  time: number;
};

export type WorkspaceChapterEditHistoryEntry = WorkspaceHistoryEntryBase & {
  kind: "chapter-edit";
  before: WorkspaceChapterEditSnapshot;
  after: WorkspaceChapterEditSnapshot;
};

export type WorkspaceMaskEditHistoryEntry = WorkspaceHistoryEntryBase & {
  kind: "mask-edit";
  before: WorkspaceMaskSnapshot;
  after: WorkspaceMaskSnapshot;
};

export type WorkspaceImageEditHistoryEntry = WorkspaceHistoryEntryBase & {
  kind: "image-edit";
  transactionId: string;
  /** Chapter this opaque transaction mutates, when known. */
  chapterId?: string;
  /**
   * Drawn-mask Flux clears its draft on success. Keeping the draft alongside
   * the opaque main-process transaction lets the single image step restore
   * both pieces of state.
   */
  mask?: {
    before: WorkspaceMaskSnapshot;
    after: WorkspaceMaskSnapshot;
  };
};

export type WorkspaceHistoryEntry =
  | WorkspaceChapterEditHistoryEntry
  | WorkspaceMaskEditHistoryEntry
  | WorkspaceImageEditHistoryEntry;

export type WorkspaceHistoryState = {
  past: WorkspaceHistoryEntry[];
  future: WorkspaceHistoryEntry[];
};

export type RecordWorkspaceHistoryOptions = {
  coalesceMs?: number;
  maxEntries?: number;
};

export type RecordWorkspaceHistoryResult = {
  state: WorkspaceHistoryState;
  releasedTransactionIds: string[];
  coalesced: boolean;
};

export type WorkspaceHistoryReplayResult = {
  entry: WorkspaceHistoryEntry;
  outcome: WorkspaceHistoryApplyOutcome;
  state: WorkspaceHistoryState;
};

export function emptyWorkspaceHistory(): WorkspaceHistoryState {
  return { past: [], future: [] };
}

/** Records a completed operation and reports image revisions no longer used. */
export function recordWorkspaceHistory(
  state: WorkspaceHistoryState,
  entry: WorkspaceHistoryEntry,
  options: RecordWorkspaceHistoryOptions = {},
): RecordWorkspaceHistoryResult {
  const released = collectImageTransactionIds(state.future);
  const coalesced =
    state.future.length === 0
      ? coalesceHistoryEntry(
          state.past.at(-1),
          entry,
          options.coalesceMs ?? WORKSPACE_HISTORY_COALESCE_MS,
        )
      : null;
  const nextPast = coalesced
    ? [...state.past.slice(0, -1), coalesced]
    : [...state.past, entry];
  const maxEntries = Math.max(
    1,
    options.maxEntries ?? WORKSPACE_HISTORY_MAX_ENTRIES,
  );
  const trimCount = Math.max(0, nextPast.length - maxEntries);
  const trimmed = nextPast.slice(0, trimCount);

  return {
    state: {
      past: trimCount > 0 ? nextPast.slice(trimCount) : nextPast,
      future: [],
    },
    releasedTransactionIds: uniqueStrings([
      ...released,
      ...collectImageTransactionIds(trimmed),
    ]),
    coalesced: coalesced !== null,
  };
}

export function peekWorkspaceHistory(
  state: WorkspaceHistoryState,
  direction: WorkspaceHistoryDirection,
): WorkspaceHistoryEntry | null {
  const stack = direction === "undo" ? state.past : state.future;
  return stack.at(-1) ?? null;
}

export function hasSameVisibleWorkspaceHistoryState(
  previous: WorkspaceHistoryState,
  next: WorkspaceHistoryState,
): boolean {
  const previousUndo = peekWorkspaceHistory(previous, "undo");
  const nextUndo = peekWorkspaceHistory(next, "undo");
  const previousRedo = peekWorkspaceHistory(previous, "redo");
  const nextRedo = peekWorkspaceHistory(next, "redo");
  return (
    Boolean(previousUndo) === Boolean(nextUndo) &&
    Boolean(previousRedo) === Boolean(nextRedo) &&
    previousUndo?.label === nextUndo?.label &&
    previousRedo?.label === nextRedo?.label
  );
}

/**
 * Moves exactly the entry that was successfully applied. The id guard prevents
 * an async replay from committing against a stack which changed meanwhile.
 */
function commitWorkspaceHistoryReplay(
  state: WorkspaceHistoryState,
  direction: WorkspaceHistoryDirection,
  entryId: string,
): WorkspaceHistoryState | null {
  const entry = peekWorkspaceHistory(state, direction);
  if (!entry || entry.id !== entryId) {
    return null;
  }
  if (direction === "undo") {
    return {
      past: state.past.slice(0, -1),
      future: [...state.future, entry],
    };
  }
  return {
    past: [...state.past, entry],
    future: state.future.slice(0, -1),
  };
}

/**
 * Drops a transaction which the main process has explicitly invalidated.
 * Unlike a successful replay it is not moved to the opposite stack, because
 * the opaque transaction no longer exists and can never be replayed again.
 */
function discardWorkspaceHistoryReplay(
  state: WorkspaceHistoryState,
  direction: WorkspaceHistoryDirection,
  entryId: string,
): WorkspaceHistoryState | null {
  const entry = peekWorkspaceHistory(state, direction);
  if (!entry || entry.id !== entryId) {
    return null;
  }
  return direction === "undo"
    ? { past: state.past.slice(0, -1), future: state.future }
    : { past: state.past, future: state.future.slice(0, -1) };
}

/**
 * Applies first and commits second. A rejection leaves the input state intact,
 * which is the central invariant used by the React controller.
 */
export async function replayWorkspaceHistory(
  state: WorkspaceHistoryState,
  direction: WorkspaceHistoryDirection,
  apply: (
    entry: WorkspaceHistoryEntry,
    direction: WorkspaceHistoryDirection,
  ) =>
    | void
    | WorkspaceHistoryApplyOutcome
    | Promise<void | WorkspaceHistoryApplyOutcome>,
): Promise<WorkspaceHistoryReplayResult | null> {
  const entry = peekWorkspaceHistory(state, direction);
  if (!entry) {
    return null;
  }
  const outcome = (await apply(entry, direction)) ?? "applied";
  const next =
    outcome === "invalidated"
      ? discardWorkspaceHistoryReplay(state, direction, entry.id)
      : commitWorkspaceHistoryReplay(state, direction, entry.id);
  return next ? { entry, outcome, state: next } : null;
}

export function clearWorkspaceHistory(
  state: WorkspaceHistoryState,
): RecordWorkspaceHistoryResult {
  return {
    state: emptyWorkspaceHistory(),
    releasedTransactionIds: uniqueStrings([
      ...collectImageTransactionIds(state.past),
      ...collectImageTransactionIds(state.future),
    ]),
    coalesced: false,
  };
}

export function captureWorkspaceChapterEditSnapshot(
  chapter: Pick<ChapterSnapshot, "id" | "pages">,
  selection: WorkspaceSelectionSnapshot,
  pageIds?: Iterable<string>,
): WorkspaceChapterEditSnapshot {
  const includedPageIds = pageIds ? new Set(pageIds) : null;
  return {
    chapterId: chapter.id,
    pages: chapter.pages
      .filter((page) => !includedPageIds || includedPageIds.has(page.id))
      .map((page) => ({
        pageId: page.id,
        blocks: page.blocks,
      })),
    selectedPageId: selection.selectedPageId,
    selectedBlockId: selection.selectedBlockId,
    selectedBlockIds: [...selection.selectedBlockIds],
  };
}

/** Restores only block arrays, preserving current image/job metadata. */
export function restoreWorkspaceChapterEditSnapshot(
  chapter: ChapterSnapshot,
  snapshot: WorkspaceChapterEditSnapshot,
): ChapterSnapshot {
  assertMatchingChapter(chapter.id, snapshot.chapterId);
  const blocksByPage = new Map(
    snapshot.pages.map((page) => [page.pageId, page.blocks]),
  );
  for (const pageId of blocksByPage.keys()) {
    if (!chapter.pages.some((page) => page.id === pageId)) {
      throw new Error(`Workspace history page is no longer open: ${pageId}`);
    }
  }
  return {
    ...chapter,
    pages: chapter.pages.map((page) => {
      const blocks = blocksByPage.get(page.id);
      return blocks ? { ...page, blocks } : page;
    }),
  };
}

export function captureWorkspaceMaskSnapshot(
  chapterId: string,
  pageId: string,
  strokes: InpaintingMaskStroke[],
): WorkspaceMaskSnapshot {
  return { chapterId, pageId, strokes };
}

export function resolveWorkspaceChapterHistoryTarget(
  entry: WorkspaceChapterEditHistoryEntry,
  direction: WorkspaceHistoryDirection,
): WorkspaceChapterEditSnapshot {
  return direction === "undo" ? entry.before : entry.after;
}

export function resolveWorkspaceMaskHistoryTarget(
  entry: WorkspaceMaskEditHistoryEntry,
  direction: WorkspaceHistoryDirection,
): WorkspaceMaskSnapshot {
  return direction === "undo" ? entry.before : entry.after;
}

function coalesceHistoryEntry(
  previous: WorkspaceHistoryEntry | undefined,
  next: WorkspaceHistoryEntry,
  coalesceMs: number,
): WorkspaceHistoryEntry | null {
  if (
    !previous ||
    !next.mergeKey ||
    previous.mergeKey !== next.mergeKey ||
    previous.kind !== next.kind
  ) {
    return null;
  }
  const elapsed = next.time - previous.time;
  if (elapsed < 0 || elapsed >= coalesceMs) {
    return null;
  }
  return mergeCompatibleEntries(previous, next);
}

function mergeCompatibleEntries(
  previous: WorkspaceHistoryEntry,
  next: WorkspaceHistoryEntry,
): WorkspaceHistoryEntry | null {
  if (previous.kind === "chapter-edit" && next.kind === "chapter-edit") {
    return previous.before.chapterId === next.before.chapterId
      ? { ...next, id: previous.id, before: previous.before }
      : null;
  }
  if (previous.kind !== "mask-edit" || next.kind !== "mask-edit") {
    // Opaque image transactions must always remain individually addressable.
    return null;
  }
  const sameMask =
    previous.before.chapterId === next.before.chapterId &&
    previous.before.pageId === next.before.pageId;
  return sameMask
    ? { ...next, id: previous.id, before: previous.before }
    : null;
}

function collectImageTransactionIds(
  entries: WorkspaceHistoryEntry[],
): string[] {
  return entries.flatMap((entry) =>
    entry.kind === "image-edit" ? [entry.transactionId] : [],
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function assertMatchingChapter(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(
      `Workspace history chapter mismatch: expected ${expected}, received ${actual}`,
    );
  }
}
