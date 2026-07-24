import {
  useCallback,
  useMemo,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { hashTranslationBlocks } from "../../../shared/blockFingerprint";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type {
  ChapterPersistenceRefs,
  DirtyTrackingActions,
  QueuedSaveRunner,
  ServerVersionSyncActions,
} from "./chapterPersistenceTypes";

export function useDirtyTrackingActions({
  currentChapterRef,
  refs,
  runQueuedSave,
  setDirty,
  setDirtyVersion,
  syncServerPageVersions,
}: {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  refs: ChapterPersistenceRefs;
  runQueuedSave: QueuedSaveRunner;
  setDirty: Dispatch<SetStateAction<boolean>>;
  setDirtyVersion: Dispatch<SetStateAction<number>>;
  syncServerPageVersions: ServerVersionSyncActions["syncServerPageVersions"];
}): DirtyTrackingActions {
  const resetSaveBaseline = useResetSaveBaselineAction({
    currentChapterRef,
    syncServerPageVersions,
  });
  const clearDirtyTracking = useClearDirtyTrackingAction({
    refs,
    resetSaveBaseline,
    setDirty,
  });
  const markDirty = useMarkDirtyAction({
    currentChapterRef,
    refs,
    setDirty,
    setDirtyVersion,
  });
  const replaceDirtyPageIds = useReplaceDirtyPageIdsAction({ refs, setDirty });
  const saveNow = useSaveNowAction({
    currentChapterRef,
    refs,
    runQueuedSave,
  });

  return useMemo(
    () => ({
      clearDirtyTracking,
      markDirty,
      replaceDirtyPageIds,
      resetSaveBaseline,
      saveNow,
    }),
    [
      clearDirtyTracking,
      markDirty,
      replaceDirtyPageIds,
      resetSaveBaseline,
      saveNow,
    ],
  );
}

function useMarkDirtyAction({
  currentChapterRef,
  refs,
  setDirty,
  setDirtyVersion,
}: {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  refs: ChapterPersistenceRefs;
  setDirty: Dispatch<SetStateAction<boolean>>;
  setDirtyVersion: Dispatch<SetStateAction<number>>;
}): DirtyTrackingActions["markDirty"] {
  const {
    blockedAutoSaveVersionRef,
    dirtyPageIdsRef,
    dirtyVersionRef,
    serverVersionByPageIdRef,
    serverVersionChapterIdRef,
  } = refs;
  return useCallback(
    (pageId?: string) => {
      dirtyVersionRef.current += 1;
      setDirtyVersion(dirtyVersionRef.current);
      blockedAutoSaveVersionRef.current = null;
      if (pageId) {
        if (!dirtyPageIdsRef.current.has(pageId)) {
          const page = currentChapterRef.current?.pages.find(
            (candidate) => candidate.id === pageId,
          );
          if (page && !serverVersionByPageIdRef.current.has(pageId)) {
            serverVersionByPageIdRef.current.set(pageId, {
              updatedAt: page.updatedAt,
              blocksHash: hashTranslationBlocks(page.blocks),
            });
            serverVersionChapterIdRef.current =
              currentChapterRef.current?.id ??
              serverVersionChapterIdRef.current;
          }
        }
        dirtyPageIdsRef.current = new Set([...dirtyPageIdsRef.current, pageId]);
      }
      setDirty(true);
    },
    [
      blockedAutoSaveVersionRef,
      currentChapterRef,
      dirtyPageIdsRef,
      dirtyVersionRef,
      serverVersionByPageIdRef,
      serverVersionChapterIdRef,
      setDirty,
      setDirtyVersion,
    ],
  );
}

function useResetSaveBaselineAction({
  currentChapterRef,
  syncServerPageVersions,
}: {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  syncServerPageVersions: ServerVersionSyncActions["syncServerPageVersions"];
}): DirtyTrackingActions["resetSaveBaseline"] {
  return useCallback(
    (
      chapter: ChapterSnapshot | null | undefined = currentChapterRef.current,
    ) => {
      syncServerPageVersions(chapter ?? null);
    },
    [currentChapterRef, syncServerPageVersions],
  );
}

function useClearDirtyTrackingAction({
  refs,
  resetSaveBaseline,
  setDirty,
}: {
  refs: ChapterPersistenceRefs;
  resetSaveBaseline: DirtyTrackingActions["resetSaveBaseline"];
  setDirty: Dispatch<SetStateAction<boolean>>;
}): DirtyTrackingActions["clearDirtyTracking"] {
  const { blockedAutoSaveVersionRef, dirtyPageIdsRef, saveTimerRef } = refs;
  return useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    blockedAutoSaveVersionRef.current = null;
    dirtyPageIdsRef.current.clear();
    resetSaveBaseline();
    setDirty(false);
  }, [
    blockedAutoSaveVersionRef,
    dirtyPageIdsRef,
    resetSaveBaseline,
    saveTimerRef,
    setDirty,
  ]);
}

function useReplaceDirtyPageIdsAction({
  refs,
  setDirty,
}: {
  refs: ChapterPersistenceRefs;
  setDirty: Dispatch<SetStateAction<boolean>>;
}): DirtyTrackingActions["replaceDirtyPageIds"] {
  const { blockedAutoSaveVersionRef, dirtyPageIdsRef } = refs;
  return useCallback(
    (pageIds: string[]) => {
      if (pageIds.length === 0) {
        blockedAutoSaveVersionRef.current = null;
      }
      dirtyPageIdsRef.current = new Set(pageIds);
      setDirty(pageIds.length > 0);
    },
    [blockedAutoSaveVersionRef, dirtyPageIdsRef, setDirty],
  );
}

function useSaveNowAction({
  currentChapterRef,
  refs,
  runQueuedSave,
}: {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  refs: ChapterPersistenceRefs;
  runQueuedSave: QueuedSaveRunner;
}): DirtyTrackingActions["saveNow"] {
  const { blockedAutoSaveVersionRef, saveTimerRef } = refs;
  return useCallback(async () => {
    const chapter = currentChapterRef.current;
    if (!chapter) {
      return;
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    blockedAutoSaveVersionRef.current = null;
    await runQueuedSave("manual");
  }, [
    blockedAutoSaveVersionRef,
    currentChapterRef,
    runQueuedSave,
    saveTimerRef,
  ]);
}
