import { useCallback, type Dispatch, type SetStateAction } from "react";
import type {
  ChapterPersistenceRefs,
  PersistChapter,
  QueuedSaveRunner,
  SaveReason,
  ServerVersionSyncActions,
  UseChapterPersistenceOptions,
} from "./chapterPersistenceTypes";

type QueuedChapterSaveOptions = {
  currentChapterRef: UseChapterPersistenceOptions["currentChapterRef"];
  persistChapter: PersistChapter;
  refs: ChapterPersistenceRefs;
  setCurrentChapter: UseChapterPersistenceOptions["setCurrentChapter"];
  setDirty: Dispatch<SetStateAction<boolean>>;
  syncServerPageVersions: ServerVersionSyncActions["syncServerPageVersions"];
};

type QueuedSaveLoopOptions = QueuedChapterSaveOptions & {
  reason: SaveReason;
};

export function useQueuedChapterSave({
  currentChapterRef,
  persistChapter,
  refs,
  setCurrentChapter,
  setDirty,
  syncServerPageVersions,
}: QueuedChapterSaveOptions): QueuedSaveRunner {
  const { saveAgainReasonRef, saveAgainRequestedRef, saveInFlightRef } = refs;
  const { saveQueuePromiseRef } = refs;

  return useCallback<QueuedSaveRunner>(
    async (reason) => {
      if (saveInFlightRef.current) {
        saveAgainRequestedRef.current = true;
        saveAgainReasonRef.current = mergeSaveReason(
          saveAgainReasonRef.current,
          reason,
        );
        await (saveQueuePromiseRef.current ?? Promise.resolve());
        return;
      }

      const queuedSave = runQueuedSaveLoop({
        currentChapterRef,
        persistChapter,
        reason,
        refs,
        setCurrentChapter,
        setDirty,
        syncServerPageVersions,
      });
      saveQueuePromiseRef.current = queuedSave;
      await queuedSave;
    },
    [
      currentChapterRef,
      persistChapter,
      refs,
      saveAgainReasonRef,
      saveAgainRequestedRef,
      saveInFlightRef,
      saveQueuePromiseRef,
      setCurrentChapter,
      setDirty,
      syncServerPageVersions,
    ],
  );
}

async function runQueuedSaveLoop({
  currentChapterRef,
  persistChapter,
  reason,
  refs,
  setCurrentChapter,
  setDirty,
  syncServerPageVersions,
}: QueuedSaveLoopOptions): Promise<void> {
  refs.saveInFlightRef.current = true;
  try {
    do {
      await runQueuedSaveIteration({
        currentChapterRef,
        persistChapter,
        reason,
        refs,
        setCurrentChapter,
        setDirty,
        syncServerPageVersions,
      });
    } while (refs.saveAgainRequestedRef.current);
  } finally {
    refs.saveInFlightRef.current = false;
    refs.saveQueuePromiseRef.current = null;
  }
}

async function runQueuedSaveIteration({
  currentChapterRef,
  persistChapter,
  reason,
  refs,
  setCurrentChapter,
  setDirty,
  syncServerPageVersions,
}: QueuedSaveLoopOptions): Promise<void> {
  const saveReason = refs.saveAgainReasonRef.current ?? reason;
  refs.saveAgainRequestedRef.current = false;
  refs.saveAgainReasonRef.current = null;
  const chapter = currentChapterRef.current;
  if (!chapter) {
    return;
  }
  if (refs.dirtyPageIdsRef.current.size === 0) {
    markSaveSettled(refs, setDirty);
    return;
  }

  const savedVersion = refs.dirtyVersionRef.current;
  const saved = await persistChapter(chapter, {
    dirtyVersion: savedVersion,
    saveReason,
    syncState: false,
  });
  if (refs.dirtyVersionRef.current !== savedVersion) {
    refs.saveAgainRequestedRef.current = true;
    refs.saveAgainReasonRef.current = mergeSaveReason(
      refs.saveAgainReasonRef.current,
      saveReason,
    );
    return;
  }

  if (currentChapterRef.current?.id === saved.id) {
    currentChapterRef.current = saved;
    setCurrentChapter(saved);
  }
  refs.dirtyPageIdsRef.current.clear();
  syncServerPageVersions(saved);
  markSaveSettled(refs, setDirty);
}

function markSaveSettled(
  refs: ChapterPersistenceRefs,
  setDirty: Dispatch<SetStateAction<boolean>>,
): void {
  refs.blockedAutoSaveVersionRef.current = null;
  refs.lastSaveErrorRef.current = null;
  setDirty(false);
}

function mergeSaveReason(
  currentReason: SaveReason | null,
  nextReason: SaveReason,
): SaveReason {
  return currentReason === "manual" || nextReason === "manual"
    ? "manual"
    : "autosave";
}
