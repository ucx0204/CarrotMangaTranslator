import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  clearWorkspaceHistory,
  emptyWorkspaceHistory,
  peekWorkspaceHistory,
  recordWorkspaceHistory,
  replayWorkspaceHistory,
  resolveWorkspaceChapterHistoryTarget,
  resolveWorkspaceMaskHistoryTarget,
  type WorkspaceChapterEditHistoryEntry,
  type WorkspaceChapterEditSnapshot,
  type WorkspaceHistoryDirection,
  type WorkspaceHistoryEntry,
  type WorkspaceHistoryApplyOutcome,
  type WorkspaceHistoryState,
  type WorkspaceImageEditHistoryEntry,
  type WorkspaceMaskEditHistoryEntry,
  type WorkspaceMaskSnapshot,
} from "../lib/workspaceHistory";

type HistoryRecordMetadata = {
  label: string;
  mergeKey?: string;
  time?: number;
};

type RecordWorkspaceChapterEdit = HistoryRecordMetadata & {
  before: WorkspaceChapterEditSnapshot;
  after: WorkspaceChapterEditSnapshot;
};

type RecordWorkspaceMaskEdit = HistoryRecordMetadata & {
  before: WorkspaceMaskSnapshot;
  after: WorkspaceMaskSnapshot;
};

type RecordWorkspaceImageEdit = Omit<HistoryRecordMetadata, "mergeKey"> & {
  transactionId: string;
  mask?: WorkspaceImageEditHistoryEntry["mask"];
};

type ApplyWorkspaceImageTransaction = (request: {
  direction: WorkspaceHistoryDirection;
  transactionId: string;
}) => Promise<WorkspaceHistoryApplyOutcome>;

export type UseWorkspaceHistoryOptions = {
  /** Changing the open chapter releases and clears the session history. */
  chapterId: string | null;
  applyChapterSnapshot: (snapshot: WorkspaceChapterEditSnapshot) => void;
  applyMaskSnapshot: (snapshot: WorkspaceMaskSnapshot) => void;
  applyImageTransaction: ApplyWorkspaceImageTransaction;
  releaseImageTransactions?: (transactionIds: string[]) => void | Promise<void>;
  onReplayError?: (
    error: unknown,
    entry: WorkspaceHistoryEntry,
    direction: WorkspaceHistoryDirection,
  ) => void;
  onReleaseError?: (error: unknown) => void;
  maxEntries?: number;
  coalesceMs?: number;
};

export type WorkspaceHistoryController = {
  recordChapterEdit: (input: RecordWorkspaceChapterEdit) => boolean;
  recordMaskEdit: (input: RecordWorkspaceMaskEdit) => boolean;
  recordImageEdit: (input: RecordWorkspaceImageEdit) => boolean;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
  reset: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  busy: boolean;
};

export function useWorkspaceHistory({
  chapterId,
  applyChapterSnapshot,
  applyMaskSnapshot,
  applyImageTransaction,
  releaseImageTransactions,
  onReplayError,
  onReleaseError,
  maxEntries,
  coalesceMs,
}: UseWorkspaceHistoryOptions): WorkspaceHistoryController {
  const busyRef = useRef(false);
  const releaseTransactions = useTransactionRelease(
    releaseImageTransactions,
    onReleaseError,
  );
  const store = useWorkspaceHistoryStore({
    busyRef,
    chapterId,
    coalesceMs,
    maxEntries,
    releaseTransactions,
  });
  const recorders = useWorkspaceHistoryRecorders(store.recordEntry);
  const applyEntry = useWorkspaceHistoryEntryApplier({
    applyChapterSnapshot,
    applyImageTransaction,
    applyMaskSnapshot,
  });
  const replay = useWorkspaceHistoryReplay({
    applyEntry,
    busyRef,
    onReplayError,
    publish: store.publish,
    stateRef: store.stateRef,
  });
  const undoEntry = peekWorkspaceHistory(store.state, "undo");
  const redoEntry = peekWorkspaceHistory(store.state, "redo");

  return {
    ...recorders,
    undo: replay.undo,
    redo: replay.redo,
    reset: store.reset,
    canUndo: Boolean(undoEntry),
    canRedo: Boolean(redoEntry),
    undoLabel: undoEntry?.label ?? null,
    redoLabel: redoEntry?.label ?? null,
    busy: replay.busy,
  };
}

type ReleaseTransactions = (transactionIds: string[]) => void;

function useTransactionRelease(
  release: UseWorkspaceHistoryOptions["releaseImageTransactions"],
  onError: UseWorkspaceHistoryOptions["onReleaseError"],
): ReleaseTransactions {
  const releaseRef = useRef(release);
  const errorRef = useRef(onError);
  useEffect(() => {
    releaseRef.current = release;
    errorRef.current = onError;
  }, [onError, release]);
  return useCallback((transactionIds) => {
    if (transactionIds.length === 0 || !releaseRef.current) return;
    try {
      void Promise.resolve(releaseRef.current(transactionIds)).catch((error) =>
        errorRef.current?.(error),
      );
    } catch (error) {
      errorRef.current?.(error);
    }
  }, []);
}

type WorkspaceHistoryStore = {
  state: WorkspaceHistoryState;
  stateRef: MutableRefObject<WorkspaceHistoryState>;
  publish: (next: WorkspaceHistoryState) => void;
  recordEntry: (entry: WorkspaceHistoryEntry) => boolean;
  reset: () => void;
};

function useWorkspaceHistoryStore({
  busyRef,
  chapterId,
  coalesceMs,
  maxEntries,
  releaseTransactions,
}: Pick<
  UseWorkspaceHistoryOptions,
  "chapterId" | "coalesceMs" | "maxEntries"
> & {
  busyRef: MutableRefObject<boolean>;
  releaseTransactions: ReleaseTransactions;
}): WorkspaceHistoryStore {
  const stateRef = useRef<WorkspaceHistoryState>(emptyWorkspaceHistory());
  const [state, setState] = useState<WorkspaceHistoryState>(
    emptyWorkspaceHistory,
  );
  const publish = useCallback((next: WorkspaceHistoryState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const reset = useCallback(() => {
    const cleared = clearWorkspaceHistory(stateRef.current);
    publish(cleared.state);
    releaseTransactions(cleared.releasedTransactionIds);
  }, [publish, releaseTransactions]);
  useResetWorkspaceHistoryEffects({
    chapterId,
    releaseTransactions,
    reset,
    stateRef,
  });
  const recordEntry = useCallback(
    (entry: WorkspaceHistoryEntry) => {
      if (busyRef.current) {
        if (entry.kind === "image-edit") {
          releaseTransactions([entry.transactionId]);
        }
        return false;
      }
      const result = recordWorkspaceHistory(stateRef.current, entry, {
        coalesceMs,
        maxEntries,
      });
      publish(result.state);
      releaseTransactions(result.releasedTransactionIds);
      return true;
    },
    [busyRef, coalesceMs, maxEntries, publish, releaseTransactions],
  );
  return { state, stateRef, publish, recordEntry, reset };
}

function useResetWorkspaceHistoryEffects({
  chapterId,
  releaseTransactions,
  reset,
  stateRef,
}: {
  chapterId: string | null;
  releaseTransactions: ReleaseTransactions;
  reset: () => void;
  stateRef: MutableRefObject<WorkspaceHistoryState>;
}): void {
  const activeChapterRef = useRef(chapterId);
  useEffect(() => {
    if (activeChapterRef.current === chapterId) return;
    activeChapterRef.current = chapterId;
    reset();
  }, [chapterId, reset]);
  useEffect(
    () => () => {
      const cleared = clearWorkspaceHistory(stateRef.current);
      stateRef.current = cleared.state;
      releaseTransactions(cleared.releasedTransactionIds);
    },
    [releaseTransactions, stateRef],
  );
}

function useWorkspaceHistoryRecorders(
  recordEntry: WorkspaceHistoryStore["recordEntry"],
): Pick<
  WorkspaceHistoryController,
  "recordChapterEdit" | "recordMaskEdit" | "recordImageEdit"
> {
  const recordChapterEdit = useCallback(
    (input: RecordWorkspaceChapterEdit) =>
      recordEntry(createChapterEntry(input)),
    [recordEntry],
  );
  const recordMaskEdit = useCallback(
    (input: RecordWorkspaceMaskEdit) => recordEntry(createMaskEntry(input)),
    [recordEntry],
  );
  const recordImageEdit = useCallback(
    (input: RecordWorkspaceImageEdit) => recordEntry(createImageEntry(input)),
    [recordEntry],
  );
  return { recordChapterEdit, recordMaskEdit, recordImageEdit };
}

type EntryApplier = (
  entry: WorkspaceHistoryEntry,
  direction: WorkspaceHistoryDirection,
) => Promise<WorkspaceHistoryApplyOutcome>;

function useWorkspaceHistoryEntryApplier({
  applyChapterSnapshot,
  applyImageTransaction,
  applyMaskSnapshot,
}: Pick<
  UseWorkspaceHistoryOptions,
  "applyChapterSnapshot" | "applyImageTransaction" | "applyMaskSnapshot"
>): EntryApplier {
  return useCallback(
    async (entry, direction) => {
      if (entry.kind === "chapter-edit") {
        applyChapterSnapshot(
          resolveWorkspaceChapterHistoryTarget(entry, direction),
        );
        return "applied";
      }
      if (entry.kind === "mask-edit") {
        applyMaskSnapshot(resolveWorkspaceMaskHistoryTarget(entry, direction));
        return "applied";
      }
      const mask = entry.mask?.[direction === "undo" ? "before" : "after"];
      const rollbackMask =
        entry.mask?.[direction === "undo" ? "after" : "before"];
      if (mask) applyMaskSnapshot(mask);
      try {
        const outcome = await applyImageTransaction({
          direction,
          transactionId: entry.transactionId,
        });
        if (outcome === "invalidated" && rollbackMask) {
          applyMaskSnapshot(rollbackMask);
        }
        return outcome;
      } catch (error) {
        if (rollbackMask) applyMaskSnapshot(rollbackMask);
        throw error;
      }
    },
    [applyChapterSnapshot, applyImageTransaction, applyMaskSnapshot],
  );
}

function useWorkspaceHistoryReplay({
  applyEntry,
  busyRef,
  onReplayError,
  publish,
  stateRef,
}: {
  applyEntry: EntryApplier;
  busyRef: MutableRefObject<boolean>;
  onReplayError: UseWorkspaceHistoryOptions["onReplayError"];
  publish: WorkspaceHistoryStore["publish"];
  stateRef: MutableRefObject<WorkspaceHistoryState>;
}): Pick<WorkspaceHistoryController, "busy" | "undo" | "redo"> {
  const [busy, setBusy] = useState(false);
  const runReplay = useCallback(
    async (direction: WorkspaceHistoryDirection) => {
      if (busyRef.current) return false;
      const original = stateRef.current;
      const entry = peekWorkspaceHistory(original, direction);
      if (!entry) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        const result = await replayWorkspaceHistory(
          original,
          direction,
          applyEntry,
        );
        if (!result || stateRef.current !== original) return false;
        publish(result.state);
        return result.outcome === "applied";
      } catch (error) {
        onReplayError?.(error, entry, direction);
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [applyEntry, busyRef, onReplayError, publish, stateRef],
  );
  const undo = useCallback(() => runReplay("undo"), [runReplay]);
  const redo = useCallback(() => runReplay("redo"), [runReplay]);
  return { busy, undo, redo };
}

function createChapterEntry(
  input: RecordWorkspaceChapterEdit,
): WorkspaceChapterEditHistoryEntry {
  return {
    kind: "chapter-edit",
    id: createHistoryEntryId(),
    label: input.label,
    mergeKey: input.mergeKey,
    time: input.time ?? Date.now(),
    before: input.before,
    after: input.after,
  };
}

function createMaskEntry(
  input: RecordWorkspaceMaskEdit,
): WorkspaceMaskEditHistoryEntry {
  return {
    kind: "mask-edit",
    id: createHistoryEntryId(),
    label: input.label,
    mergeKey: input.mergeKey,
    time: input.time ?? Date.now(),
    before: input.before,
    after: input.after,
  };
}

function createImageEntry(
  input: RecordWorkspaceImageEdit,
): WorkspaceImageEditHistoryEntry {
  return {
    kind: "image-edit",
    id: createHistoryEntryId(),
    label: input.label,
    time: input.time ?? Date.now(),
    transactionId: input.transactionId,
    mask: input.mask,
  };
}

let fallbackHistoryId = 0;

function createHistoryEntryId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackHistoryId += 1;
  return `workspace-history-${Date.now()}-${fallbackHistoryId}`;
}
