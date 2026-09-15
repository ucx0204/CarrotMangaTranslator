import { useEffect, useRef, type MutableRefObject } from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { mcpGateway } from "../api/mcpGateway";
import { libraryGateway } from "../api/libraryGateway";
import { createLiveChapterRefreshCoordinator } from "../lib/liveChapterRefreshCoordinator";

type Options = {
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  dirtyPageIdsRef: MutableRefObject<Set<string>>;
  hasPendingInpaintingMask: boolean;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
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
    const refresh = createLiveChapterRefreshCoordinator({
      getCurrentChapterId: () => latest.current.currentChapterRef.current?.id,
      openChapter: (id) => libraryGateway.openChapter(id),
      mergeLiveChapter: (chapter) => latest.current.mergeLiveChapter(chapter),
      reportError,
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
      refresh.dispose();
    };
  }, []);
}
