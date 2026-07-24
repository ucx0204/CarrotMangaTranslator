import type { ChapterSnapshot } from "../../../shared/libraryTypes";

export type LiveChapterRefreshPort = {
  getCurrentChapterId: () => string | undefined;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  reportError: (error: unknown) => void;
};

export type LiveChapterRefreshCoordinator = {
  dispose: () => void;
  request: () => void;
};

type ChapterRefreshState = {
  trailingRequested: boolean;
};

export function createLiveChapterRefreshCoordinator(
  port: LiveChapterRefreshPort,
): LiveChapterRefreshCoordinator {
  const refreshStateByChapter = new Map<string, ChapterRefreshState>();
  let disposed = false;

  const runRefresh = async (
    chapterId: string,
    state: ChapterRefreshState,
  ): Promise<void> => {
    state.trailingRequested = false;
    try {
      const chapter = await port.openChapter(chapterId);
      if (!disposed && port.getCurrentChapterId() === chapter.id) {
        port.mergeLiveChapter(chapter);
      }
    } catch (error) {
      port.reportError(error);
    } finally {
      if (
        !disposed &&
        state.trailingRequested &&
        port.getCurrentChapterId() === chapterId
      ) {
        void runRefresh(chapterId, state);
      } else {
        refreshStateByChapter.delete(chapterId);
      }
    }
  };

  return {
    dispose: () => {
      disposed = true;
      refreshStateByChapter.clear();
    },
    request: () => {
      if (disposed) {
        return;
      }
      const chapterId = port.getCurrentChapterId();
      if (!chapterId) {
        return;
      }

      const activeState = refreshStateByChapter.get(chapterId);
      if (activeState) {
        activeState.trailingRequested = true;
        return;
      }

      const state: ChapterRefreshState = {
        trailingRequested: false,
      };
      refreshStateByChapter.set(chapterId, state);
      void runRefresh(chapterId, state);
    },
  };
}
