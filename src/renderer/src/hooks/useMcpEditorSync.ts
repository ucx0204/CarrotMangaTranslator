import { createLibraryRefreshCoordinator } from "../lib/libraryRefreshCoordinator";
import { useEffect, useRef, type MutableRefObject } from "react";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import { mcpGateway } from "../api/mcpGateway";
import { libraryGateway } from "../api/libraryGateway";
import type { LiveChapterMergeOptions } from "../lib/chapterSync";
import { createLiveChapterRefreshCoordinator } from "../lib/liveChapterRefreshCoordinator";

type Options = {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  dirtyPageIdsRef: MutableRefObject<Set<string>>;
  hasPendingInpaintingMask: boolean;
  mergeLiveChapter: (
    chapter: ChapterSnapshot,
    options?: LiveChapterMergeOptions,
  ) => void;
  setLibrary: (library: LibraryIndex) => void;
};
/** Remote edits refresh the actual editor using its existing dirty-page merge. */
export function useMcpEditorSync(options: Options): void {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  }, [options]);
  useEffect(() => {
    let warned = false;
    const reportError = (error: unknown) => {
      if (!warned) {
        warned = true;
        console.warn("MCP editor synchronization unavailable", error);
      }
    };
    const library = createLibraryRefreshCoordinator({
      read: () => libraryGateway.getLibrary(),
      publish: (value) => latest.current.setLibrary(value),
      reportError,
    });
    const metadataRequested = new Set<string>();
    const refresh = createLiveChapterRefreshCoordinator({
      discardSuperseded: true,
      getCurrentChapterId: () => latest.current.currentChapterRef.current?.id,
      openChapter: (id) =>
        libraryGateway.openChapter(
          id,
          latest.current.currentChapterRef.current?.workId,
        ),
      mergeLiveChapter: (chapter) => {
        const metadata = metadataRequested.delete(chapter.id);
        if (metadata)
          latest.current.mergeLiveChapter(chapter, {
            preferLiveMetadata: true,
          });
        else latest.current.mergeLiveChapter(chapter);
      },
      reportError,
    });
    const unsubscribeLibrary = mcpGateway.onMcpLibraryChanged((event) => {
      library.request();
      const current = latest.current.currentChapterRef.current;
      if (
        current?.workId === event.workId &&
        (!event.chapterId || event.chapterId === current.id)
      ) {
        metadataRequested.add(current.id);
        refresh.request();
      }
    });
    const unsubscribe = mcpGateway.onMcpPageChanged((event) => {
      if (event.chapterId === latest.current.currentChapterRef.current?.id)
        refresh.request();
    });
    async function report(probeId: number) {
      const state = latest.current;
      try {
        await mcpGateway.reportMcpEditorState({
          probeId,
          chapterId: state.currentChapterRef.current?.id ?? null,
          dirtyPageIds: [...state.dirtyPageIdsRef.current],
          hasPendingInpaintingMask: state.hasPendingInpaintingMask,
        });
      } catch (error) {
        reportError(error);
      }
    }
    const unsubscribeProbe = mcpGateway.onMcpEditorProbe(({ id }) => {
      void report(id);
    });
    return () => {
      unsubscribeProbe();
      unsubscribe();
      unsubscribeLibrary();
      library.dispose();
      refresh.dispose();
    };
  }, []);
}
