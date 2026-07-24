import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { inpaintingGateway as mangaGateway } from "../../api/inpaintingGateway";
import { useWorkspaceHistory } from "../../hooks/useWorkspaceHistory";
import { formatErrorMessage } from "../../lib/errorPresentation";
import {
  restoreWorkspaceChapterEditSnapshot,
  type WorkspaceChapterEditSnapshot,
  type WorkspaceMaskSnapshot,
} from "../../lib/workspaceHistory";
import type { ChapterSessionController } from "./useChapterSessionController";

export type WorkspaceHistoryChapterController = {
  core: Pick<
    ChapterSessionController["core"],
    | "currentChapter"
    | "currentChapterRef"
    | "selectedBlockIdRef"
    | "selectedPageIdRef"
    | "setCurrentChapter"
    | "setSelectedBlockId"
    | "setSelectedBlockIds"
    | "setSelectedPageId"
  >;
  derivedState: Pick<
    ChapterSessionController["derivedState"],
    "clearPageImageCache"
  >;
  libraryActions: Pick<
    ChapterSessionController["libraryActions"],
    "refreshLibrary"
  >;
  mergeLiveChapter: ChapterSessionController["mergeLiveChapter"];
  persistence: Pick<ChapterSessionController["persistence"], "markDirty">;
  statusLog: Pick<ChapterSessionController["statusLog"], "pushStatus">;
  uiState: Pick<
    ChapterSessionController["uiState"],
    "setPatternMaskStrokesByPage"
  >;
};

/**
 * Owns the one chapter-scoped timeline shared by block edits, mask drafts and
 * opaque main-process image revisions.
 */
export function useAppSessionWorkspaceHistory(
  chapter: WorkspaceHistoryChapterController,
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
    onReleaseError: reportHistoryReleaseError,
  });
  useResetOnPageStructureChange(chapter.core.currentChapter, history.reset);
  return history;
}

function useResetOnPageStructureChange(
  chapter: ChapterSessionController["core"]["currentChapter"],
  reset: () => void,
): void {
  const chapterId = chapter?.id ?? null;
  const pageOrder = chapter?.pageOrder ?? EMPTY_PAGE_ORDER;
  const previousRef = useRef({ chapterId, pageOrder });
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { chapterId, pageOrder };
    if (
      previous.chapterId === chapterId &&
      !hasSamePageOrder(previous.pageOrder, pageOrder)
    ) {
      reset();
    }
  }, [chapterId, pageOrder, reset]);
}

const EMPTY_PAGE_ORDER: string[] = [];

function hasSamePageOrder(previous: string[], next: string[]): boolean {
  return (
    previous === next ||
    (previous.length === next.length &&
      previous.every((pageId, index) => pageId === next[index]))
  );
}

function useWorkspaceHistoryAppliers(
  chapter: WorkspaceHistoryChapterController,
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

function useApplyChapterSnapshot(chapter: WorkspaceHistoryChapterController) {
  const { core, persistence } = chapter;
  const {
    currentChapterRef,
    selectedBlockIdRef,
    selectedPageIdRef,
    setCurrentChapter,
    setSelectedBlockId,
    setSelectedBlockIds,
    setSelectedPageId,
  } = core;
  const { markDirty } = persistence;
  return useCallback(
    (snapshot: WorkspaceChapterEditSnapshot) => {
      const current = currentChapterRef.current;
      if (!current) {
        throw new Error("No chapter is open for workspace history.");
      }
      const next = restoreWorkspaceChapterEditSnapshot(current, snapshot);
      markChangedBlockPagesDirty(current, snapshot, markDirty);
      currentChapterRef.current = next;
      selectedPageIdRef.current = snapshot.selectedPageId;
      selectedBlockIdRef.current = snapshot.selectedBlockId;
      setCurrentChapter(next);
      setSelectedPageId(snapshot.selectedPageId);
      setSelectedBlockId(snapshot.selectedBlockId);
      setSelectedBlockIds([...snapshot.selectedBlockIds]);
    },
    [
      currentChapterRef,
      markDirty,
      selectedBlockIdRef,
      selectedPageIdRef,
      setCurrentChapter,
      setSelectedBlockId,
      setSelectedBlockIds,
      setSelectedPageId,
    ],
  );
}

function useApplyMaskSnapshot(chapter: WorkspaceHistoryChapterController) {
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
  chapter: WorkspaceHistoryChapterController,
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

function reportHistoryReleaseError(error: unknown): void {
  console.error(error);
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
