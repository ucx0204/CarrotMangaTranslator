import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
  t: TFunction<"renderer">;
};

async function saveDirtyPagesBeforePersistingPageOrder(
  dirty: boolean,
  saveNow: () => Promise<void>,
  pushStatus: (line: string) => void,
  t: TFunction<"renderer">,
): Promise<boolean> {
  try {
    if (dirty) {
      await saveNow();
    }
    return true;
  } catch (error) {
    console.error(error);
    pushStatus(
      formatErrorMessage(error, t("library.order.saveBeforePageOrderFailed")),
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
  t: TFunction<"renderer">,
): void {
  void refreshLibrary().catch((error) => {
    console.error(error);
    pushStatus(formatErrorMessage(error, t("library.refreshFailed")));
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
  const { t } = useTranslation("renderer");
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
        t,
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
      t,
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
  t,
}: PersistPageOrderAfterOptimisticReorderOptions): Promise<void> {
  try {
    const canPersist = await saveDirtyPagesBeforePersistingPageOrder(
      dirty,
      saveNow,
      pushStatus,
      t,
    );
    if (!canPersist) {
      rollbackOptimisticPageOrder({
        currentChapter,
        currentChapterRef,
        nextOrder,
        previousOrder,
        setCurrentChapter,
      });
      pushStatus(t("library.order.pageRolledBack"));
      return;
    }

    const chapter = await libraryGateway.reorderPages(
      currentChapter.id,
      nextOrder,
    );
    applyChapter(chapter);
    refreshLibraryAfterPageReorder(refreshLibrary, pushStatus, t);
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
      t("library.order.pageSaveFailed"),
    );
    pushStatus(t("library.order.rolledBackAfterError", { message }));
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
