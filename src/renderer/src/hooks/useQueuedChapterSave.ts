import { useCallback, type Dispatch, type SetStateAction } from "react";
import { createPageRevision } from "../../../shared/pageRevision";
import type {
  ChapterPersistenceRefs,
  PersistChapter,
  QueuedSaveRunner,
  SaveReason,
  QueuedSaveTarget,
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
  target?: QueuedSaveTarget;
};

export function useQueuedChapterSave({
  currentChapterRef,
  persistChapter,
  refs,
  setCurrentChapter,
  setDirty,
  syncServerPageVersions,
}: QueuedChapterSaveOptions): QueuedSaveRunner {
  const { saveQueuePromiseRef } = refs;

  return useCallback<QueuedSaveRunner>(
    async function runQueuedSave(reason, target) {
      const previous = saveQueuePromiseRef.current ?? Promise.resolve();
      const ready = target
        ? previous.catch((error) => {
            console.warn(
              "Earlier page save failed; retrying the requested pages",
              error,
            );
          })
        : previous;
      const queuedSave = ready.then(() =>
        runQueuedSaveLoop({
          currentChapterRef,
          persistChapter,
          reason,
          target,
          refs,
          setCurrentChapter,
          setDirty,
          syncServerPageVersions,
        }),
      );
      saveQueuePromiseRef.current = queuedSave;
      try {
        await queuedSave;
      } finally {
        if (saveQueuePromiseRef.current === queuedSave)
          saveQueuePromiseRef.current = null;
      }
      // Queue another batch behind already waiting page handoffs. An unrelated
      // page which is being typed into must not monopolize the save boundary.
      if (
        currentChapterRef.current &&
        (!target || currentChapterRef.current.id === target.chapterId) &&
        [...refs.dirtyPageIdsRef.current].some(
          (id) => !target || target.pageIds.includes(id),
        )
      ) {
        await runQueuedSave(reason, target);
      }
    },
    [
      currentChapterRef,
      persistChapter,
      refs,
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
  target,
  refs,
  setCurrentChapter,
  setDirty,
  syncServerPageVersions,
}: QueuedSaveLoopOptions): Promise<void> {
  refs.saveInFlightRef.current = true;
  try {
    await runQueuedSaveIteration({
      currentChapterRef,
      persistChapter,
      reason,
      target,
      refs,
      setCurrentChapter,
      setDirty,
      syncServerPageVersions,
    });
  } finally {
    refs.saveInFlightRef.current = false;
  }
}

async function runQueuedSaveIteration({
  currentChapterRef,
  persistChapter,
  reason,
  target,
  refs,
  setCurrentChapter,
  setDirty,
  syncServerPageVersions,
}: QueuedSaveLoopOptions): Promise<void> {
  const saveReason = refs.saveAgainReasonRef.current ?? reason;
  refs.saveAgainRequestedRef.current = false;
  refs.saveAgainReasonRef.current = null;
  const chapter = currentChapterRef.current;
  if (!chapter || (target && chapter.id !== target.chapterId)) {
    return;
  }
  const pageIds = [...refs.dirtyPageIdsRef.current].filter(
    (id) => !target || target.pageIds.includes(id),
  );
  if (pageIds.length === 0) {
    if (target) return;
    markSaveSettled(refs, setDirty);
    return;
  }
  const sourceById = new Map(chapter.pages.map((page) => [page.id, page]));
  if (pageIds.some((id) => !sourceById.has(id))) {
    throw new Error(
      "저장할 페이지가 현재 화에 없습니다. 편집 내용을 확인한 뒤 다시 시도해 주세요.",
    );
  }

  const savedVersion = refs.dirtyVersionRef.current;
  const saved = await persistChapter(chapter, {
    dirtyVersion: savedVersion,
    saveReason,
    syncState: false,
    pageIds,
  });
  const latest = currentChapterRef.current;
  if (latest?.id !== chapter.id) return;
  const savedIds = new Set(pageIds);
  const savedById = new Map(saved.pages.map((page) => [page.id, page]));
  if (pageIds.some((id) => !savedById.has(id))) {
    throw new Error(
      "저장 응답에 편집한 페이지가 없습니다. 현재 편집을 보존했습니다.",
    );
  }
  const next = {
    ...latest,
    pages: latest.pages.map((page) => {
      const source = sourceById.get(page.id);
      const result = savedById.get(page.id);
      if (
        !savedIds.has(page.id) ||
        !source ||
        !result ||
        (page !== source &&
          createPageRevision(page) !== createPageRevision(source))
      )
        return page;
      refs.dirtyPageIdsRef.current.delete(page.id);
      return {
        ...result,
        processingTiming: page.processingTiming,
      };
    }),
  };
  currentChapterRef.current = next;
  setCurrentChapter(next);
  syncServerPageVersions(next, { preserveDirtyPages: true });
  refs.saveAgainRequestedRef.current = [...refs.dirtyPageIdsRef.current].some(
    (id) => !target || target.pageIds.includes(id),
  );
  if (refs.dirtyPageIdsRef.current.size === 0) markSaveSettled(refs, setDirty);
  else setDirty(true);
}

function markSaveSettled(
  refs: ChapterPersistenceRefs,
  setDirty: Dispatch<SetStateAction<boolean>>,
): void {
  refs.blockedAutoSaveVersionRef.current = null;
  refs.lastSaveErrorRef.current = null;
  setDirty(false);
}
