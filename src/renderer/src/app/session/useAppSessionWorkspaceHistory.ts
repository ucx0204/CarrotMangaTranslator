import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { mangaGateway } from "../../api/mangaGateway";
import { useWorkspaceHistory } from "../../hooks/useWorkspaceHistory";
import { formatErrorMessage } from "../../lib/appHelpers";
import {
  restoreWorkspaceChapterEditSnapshot,
  type WorkspaceChapterEditSnapshot,
  type WorkspaceMaskSnapshot,
} from "../../lib/workspaceHistory";
import type { ChapterSessionController } from "./useChapterSessionController";

/**
 * Owns the one chapter-scoped timeline shared by block edits, mask drafts and
 * opaque main-process image revisions.
 */
export function useAppSessionWorkspaceHistory(
  chapter: ChapterSessionController,
) {
  const { t } = useTranslation("renderer");
  const appliers = useWorkspaceHistoryAppliers(
    chapter,
    t("library.refreshAfterJobFailed"),
  );
  const pushStatus = chapter.statusLog.pushStatus;
  const onReplayError = useCallback(
    (error: unknown) => {
      console.error(error);
      pushStatus(
        formatErrorMessage(error, "실행 취소/다시 실행에 실패했습니다."),
      );
    },
    [pushStatus],
  );

  const history = useWorkspaceHistory({
    chapterId: chapter.core.currentChapter?.id ?? null,
    ...appliers,
    onReplayError,
    onReleaseError: (error) => console.error(error),
  });
  useResetOnPageStructureChange(chapter.core.currentChapter, history.reset);
  return history;
}

function useResetOnPageStructureChange(
  chapter: ChapterSessionController["core"]["currentChapter"],
  reset: () => void,
): void {
  const chapterId = chapter?.id ?? null;
  const pageOrder = chapter?.pageOrder.join("\u0000") ?? "";
  const previousRef = useRef({ chapterId, pageOrder });
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { chapterId, pageOrder };
    if (previous.chapterId === chapterId && previous.pageOrder !== pageOrder) {
      reset();
    }
  }, [chapterId, pageOrder, reset]);
}

function useWorkspaceHistoryAppliers(
  chapter: ChapterSessionController,
  refreshFailureMessage: string,
) {
  return {
    applyChapterSnapshot: useApplyChapterSnapshot(chapter),
    applyMaskSnapshot: useApplyMaskSnapshot(chapter),
    applyImageTransaction: useApplyImageTransaction(
      chapter,
      refreshFailureMessage,
    ),
    releaseImageTransactions: useReleaseImageTransactions(),
  };
}

function useApplyChapterSnapshot(chapter: ChapterSessionController) {
  const { core, persistence } = chapter;
  return useCallback(
    (snapshot: WorkspaceChapterEditSnapshot) => {
      const current = core.currentChapterRef.current;
      if (!current) {
        throw new Error("No chapter is open for workspace history.");
      }
      const next = restoreWorkspaceChapterEditSnapshot(current, snapshot);
      markChangedBlockPagesDirty(current, snapshot, persistence.markDirty);
      core.currentChapterRef.current = next;
      core.selectedPageIdRef.current = snapshot.selectedPageId;
      core.selectedBlockIdRef.current = snapshot.selectedBlockId;
      core.setCurrentChapter(next);
      core.setSelectedPageId(snapshot.selectedPageId);
      core.setSelectedBlockId(snapshot.selectedBlockId);
      core.setSelectedBlockIds([...snapshot.selectedBlockIds]);
    },
    [core, persistence.markDirty],
  );
}

function useApplyMaskSnapshot(chapter: ChapterSessionController) {
  const currentChapterRef = chapter.core.currentChapterRef;
  const setMasks = chapter.uiState.setPatternMaskStrokesByPage;
  return useCallback(
    (snapshot: WorkspaceMaskSnapshot) => {
      const current = currentChapterRef.current;
      if (!current || current.id !== snapshot.chapterId) {
        throw new Error("The mask history belongs to a different chapter.");
      }
      if (!current.pages.some((page) => page.id === snapshot.pageId)) {
        throw new Error("The mask history page is no longer open.");
      }
      setMasks((masks) => applyMaskSnapshot(masks, snapshot));
    },
    [currentChapterRef, setMasks],
  );
}

function useApplyImageTransaction(
  chapter: ChapterSessionController,
  refreshFailureMessage: string,
) {
  const currentChapterRef = chapter.core.currentChapterRef;
  const clearPageImageCache = chapter.derivedState.clearPageImageCache;
  const refreshLibrary = chapter.libraryActions.refreshLibrary;
  const mergeLiveChapter = chapter.mergeLiveChapter;
  const pushStatus = chapter.statusLog.pushStatus;
  return useCallback(
    async (request: { transactionId: string; direction: "undo" | "redo" }) => {
      const result =
        await mangaGateway.applyInpaintingHistoryTransaction(request);
      clearPageImageCache();
      const currentChapterId = currentChapterRef.current?.id;
      const current = result.chapters.find(
        (candidate) => candidate.id === currentChapterId,
      );
      if (current) mergeLiveChapter(current);
      try {
        await refreshLibrary();
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, refreshFailureMessage));
      }
      return result.invalidated ? "invalidated" : "applied";
    },
    [
      clearPageImageCache,
      currentChapterRef,
      mergeLiveChapter,
      pushStatus,
      refreshFailureMessage,
      refreshLibrary,
    ],
  );
}

function useReleaseImageTransactions() {
  return useCallback(async (transactionIds: string[]) => {
    await mangaGateway.releaseInpaintingHistoryTransactions({ transactionIds });
  }, []);
}

function applyMaskSnapshot(
  masks: Record<string, WorkspaceMaskSnapshot["strokes"]>,
  snapshot: WorkspaceMaskSnapshot,
): Record<string, WorkspaceMaskSnapshot["strokes"]> {
  const next = { ...masks };
  if (snapshot.strokes.length > 0) next[snapshot.pageId] = snapshot.strokes;
  else delete next[snapshot.pageId];
  return next;
}

function markChangedBlockPagesDirty(
  current: ChapterSessionController["core"]["currentChapter"],
  snapshot: WorkspaceChapterEditSnapshot,
  markDirty: (pageId?: string) => void,
): void {
  if (!current) return;
  const blocksByPage = new Map(
    snapshot.pages.map((page) => [page.pageId, page.blocks]),
  );
  for (const page of current.pages) {
    const blocks = blocksByPage.get(page.id);
    if (blocks && blocks !== page.blocks) markDirty(page.id);
  }
}
