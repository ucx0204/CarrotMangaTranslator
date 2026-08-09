import {
  useCallback,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type {
  ChapterPersistenceRefs,
  ChapterSaveStatus,
  DirtyTrackingActions,
  QueuedSaveRunner,
} from "./chapterPersistenceTypes";

export function useChapterSaveStatusRunner({
  baseRunQueuedSave,
  isConflictError,
  refs,
  setSaveStatus,
}: {
  baseRunQueuedSave: QueuedSaveRunner;
  isConflictError: (error: unknown) => boolean;
  refs: ChapterPersistenceRefs;
  setSaveStatus: Dispatch<SetStateAction<ChapterSaveStatus>>;
}): QueuedSaveRunner {
  const { dirtyPageIdsRef } = refs;
  return useCallback<QueuedSaveRunner>(
    async (reason) => {
      const hadDirtyPages = dirtyPageIdsRef.current.size > 0;
      if (hadDirtyPages) setSaveStatus("saving");
      try {
        await baseRunQueuedSave(reason);
        if (hadDirtyPages) setSaveStatus("saved");
      } catch (error) {
        setSaveStatus(isConflictError(error) ? "conflict" : "error");
        throw error;
      }
    },
    [baseRunQueuedSave, dirtyPageIdsRef, isConflictError, setSaveStatus],
  );
}

export function useChapterSaveStatusActions(
  actions: DirtyTrackingActions,
  setSaveStatus: Dispatch<SetStateAction<ChapterSaveStatus>>,
): DirtyTrackingActions {
  return useMemo(
    () => ({
      ...actions,
      clearDirtyTracking: () => {
        actions.clearDirtyTracking();
        setSaveStatus("idle");
      },
      markDirty: (pageId?: string) => {
        setSaveStatus("dirty");
        actions.markDirty(pageId);
      },
      replaceDirtyPageIds: (pageIds: string[]) => {
        actions.replaceDirtyPageIds(pageIds);
        if (pageIds.length > 0) setSaveStatus("dirty");
      },
      resetSaveBaseline: (chapter?: ChapterSnapshot | null) => {
        actions.resetSaveBaseline(chapter);
        setSaveStatus("idle");
      },
    }),
    [actions, setSaveStatus],
  );
}
