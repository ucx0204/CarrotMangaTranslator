import { useCallback } from "react";
import { formatErrorMessage, reorderByTarget } from "../lib/appHelpers";
import { libraryGateway } from "./libraryGateway";
import type {
  ApplyChapterAction,
  ChapterSnapshot,
  UseLibraryActionsOptions,
} from "./libraryActionTypes";
import { isSameStringOrder, reorderChapterPages } from "./libraryOrderHelpers";

type ReorderPagesActionOptions = Pick<
  UseLibraryActionsOptions,
  | "currentChapter"
  | "currentChapterRef"
  | "dirty"
  | "pushStatus"
  | "saveNow"
  | "setCurrentChapter"
> & {
  applyChapter: ApplyChapterAction;
  refreshLibrary: () => Promise<void>;
};

type PersistPageOrderAfterOptimisticReorderOptions = Omit<
  ReorderPagesActionOptions,
  "currentChapter"
> & {
  currentChapter: ChapterSnapshot;
  nextOrder: string[];
  previousOrder: string[];
};

async function saveDirtyPagesBeforePersistingPageOrder(
  dirty: boolean,
  saveNow: () => Promise<void>,
  pushStatus: (line: string) => void,
): Promise<boolean> {
  try {
    if (dirty) {
      await saveNow();
    }
    return true;
  } catch (error) {
    console.error(error);
    pushStatus(
      formatErrorMessage(
        error,
        "현재 수정사항을 저장하지 못해 페이지 순서를 저장하지 않았습니다.",
      ),
    );
    return false;
  }
}

function applyOptimisticPageOrder({
  currentChapter,
  currentChapterRef,
  nextOrder,
  setCurrentChapter,
}: Pick<
  ReorderPagesActionOptions,
  "currentChapter" | "currentChapterRef" | "setCurrentChapter"
> & {
  nextOrder: string[];
}): void {
  if (!currentChapter) {
    return;
  }
  const baseChapter =
    currentChapterRef.current?.id === currentChapter.id
      ? currentChapterRef.current
      : currentChapter;
  const nextChapter = reorderChapterPages(baseChapter, nextOrder);
  currentChapterRef.current = nextChapter;
  setCurrentChapter(nextChapter);
}

function rollbackPageOrderIfStillOptimistic(
  latestChapter: ChapterSnapshot | null,
  currentChapterId: string,
  optimisticOrder: string[],
  previousOrder: string[],
): ChapterSnapshot | null {
  if (
    latestChapter?.id !== currentChapterId ||
    !isSameStringOrder(latestChapter.pageOrder, optimisticOrder)
  ) {
    return null;
  }
  return reorderChapterPages(latestChapter, previousOrder);
}

function refreshLibraryAfterPageReorder(
  refreshLibrary: () => Promise<void>,
  pushStatus: (line: string) => void,
): void {
  void refreshLibrary().catch((error) => {
    console.error(error);
    pushStatus(
      formatErrorMessage(error, "보관함 목록을 새로고침하지 못했습니다."),
    );
  });
}

export function useReorderPagesAction({
  applyChapter,
  currentChapter,
  currentChapterRef,
  dirty,
  pushStatus,
  refreshLibrary,
  saveNow,
  setCurrentChapter,
}: ReorderPagesActionOptions): (
  sourcePageId: string,
  targetPageId: string,
) => void {
  return useCallback(
    (sourcePageId, targetPageId) => {
      if (!currentChapter) {
        return;
      }

      const previousOrder = currentChapter.pageOrder;
      const nextOrder = reorderByTarget(
        previousOrder,
        sourcePageId,
        targetPageId,
      );
      if (isSameStringOrder(previousOrder, nextOrder)) {
        return;
      }

      applyOptimisticPageOrder({
        currentChapter,
        currentChapterRef,
        nextOrder,
        setCurrentChapter,
      });

      void persistPageOrderAfterOptimisticReorder({
        applyChapter,
        currentChapter,
        currentChapterRef,
        dirty,
        nextOrder,
        previousOrder,
        pushStatus,
        refreshLibrary,
        saveNow,
        setCurrentChapter,
      });
    },
    [
      applyChapter,
      currentChapter,
      currentChapterRef,
      dirty,
      pushStatus,
      refreshLibrary,
      saveNow,
      setCurrentChapter,
    ],
  );
}

async function persistPageOrderAfterOptimisticReorder({
  applyChapter,
  currentChapter,
  currentChapterRef,
  dirty,
  nextOrder,
  previousOrder,
  pushStatus,
  refreshLibrary,
  saveNow,
  setCurrentChapter,
}: PersistPageOrderAfterOptimisticReorderOptions): Promise<void> {
  try {
    const canPersist = await saveDirtyPagesBeforePersistingPageOrder(
      dirty,
      saveNow,
      pushStatus,
    );
    if (!canPersist) {
      rollbackOptimisticPageOrder({
        currentChapter,
        currentChapterRef,
        nextOrder,
        previousOrder,
        setCurrentChapter,
      });
      pushStatus("페이지 순서를 이전 순서로 되돌렸습니다.");
      return;
    }

    const chapter = await libraryGateway.reorderPages(
      currentChapter.id,
      nextOrder,
    );
    applyChapter(chapter);
    refreshLibraryAfterPageReorder(refreshLibrary, pushStatus);
  } catch (error) {
    console.error(error);
    rollbackOptimisticPageOrder({
      currentChapter,
      currentChapterRef,
      nextOrder,
      previousOrder,
      setCurrentChapter,
    });
    const message = formatErrorMessage(
      error,
      "페이지 순서를 저장하지 못했습니다.",
    );
    pushStatus(`${message} 이전 순서로 되돌렸습니다.`);
  }
}

function rollbackOptimisticPageOrder({
  currentChapter,
  currentChapterRef,
  nextOrder,
  previousOrder,
  setCurrentChapter,
}: Pick<
  ReorderPagesActionOptions,
  "currentChapter" | "currentChapterRef" | "setCurrentChapter"
> & {
  nextOrder: string[];
  previousOrder: string[];
}): void {
  if (!currentChapter) {
    return;
  }
  const rolledBackChapter = rollbackPageOrderIfStillOptimistic(
    currentChapterRef.current,
    currentChapter.id,
    nextOrder,
    previousOrder,
  );
  if (rolledBackChapter) {
    currentChapterRef.current = rolledBackChapter;
    setCurrentChapter(rolledBackChapter);
  }
}
