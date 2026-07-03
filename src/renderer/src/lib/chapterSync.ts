import type { ChapterSnapshot, RunMode } from "../../../shared/libraryTypes";

type ChapterSelection = {
  selectedPageId: string | null;
  selectedBlockId: string | null;
};

export type LiveChapterMergeResult = {
  chapter: ChapterSnapshot;
  preservedDirtyPageIds: string[];
};

export function resolveSelectionAfterChapterSync(
  chapter: ChapterSnapshot,
  selectedPageId: string | null,
  selectedBlockId: string | null,
): ChapterSelection {
  const nextSelectedPageId = chapter.pages.some(
    (page) => page.id === selectedPageId,
  )
    ? selectedPageId
    : (chapter.pages[0]?.id ?? null);
  const nextSelectedPage =
    chapter.pages.find((page) => page.id === nextSelectedPageId) ?? null;
  const nextSelectedBlockId =
    nextSelectedPage &&
    nextSelectedPage.blocks.some((block) => block.id === selectedBlockId)
      ? selectedBlockId
      : null;

  return {
    selectedPageId: nextSelectedPageId,
    selectedBlockId: nextSelectedBlockId,
  };
}

export function mergeLiveChapterPreservingDirtyPages(
  liveChapter: ChapterSnapshot,
  localChapter: ChapterSnapshot | null,
  dirtyPageIds: Iterable<string>,
): LiveChapterMergeResult {
  if (!localChapter || localChapter.id !== liveChapter.id) {
    return {
      chapter: liveChapter,
      preservedDirtyPageIds: [],
    };
  }

  const dirtyPageIdSet = new Set(dirtyPageIds);
  if (dirtyPageIdSet.size === 0) {
    return {
      chapter: liveChapter,
      preservedDirtyPageIds: [],
    };
  }

  const localPages = new Map(localChapter.pages.map((page) => [page.id, page]));
  const preservedDirtyPageIds: string[] = [];

  return {
    chapter: {
      ...liveChapter,
      pages: liveChapter.pages.map((page) => {
        const localPage = localPages.get(page.id);
        if (!localPage || !dirtyPageIdSet.has(page.id)) {
          return page;
        }

        preservedDirtyPageIds.push(page.id);
        return {
          ...localPage,
          inpaintedImagePath: page.inpaintedImagePath,
          analysisStatus: page.analysisStatus,
          lastError: page.lastError,
        };
      }),
    },
    preservedDirtyPageIds,
  };
}

export function markChapterPagesRunning(
  chapter: ChapterSnapshot,
  runMode: RunMode,
  pageId?: string,
  pageIds?: string[],
): ChapterSnapshot {
  const targetPageIds = resolveRunningPageIds(
    chapter,
    runMode,
    pageId,
    pageIds,
  );

  if (targetPageIds.size === 0) {
    return chapter;
  }

  return {
    ...chapter,
    status: "running",
    pages: chapter.pages.map((page) =>
      targetPageIds.has(page.id)
        ? {
            ...page,
            analysisStatus: "running",
            lastError: undefined,
          }
        : page,
    ),
  };
}

function resolveRunningPageIds(
  chapter: ChapterSnapshot,
  runMode: RunMode,
  pageId: string | undefined,
  pageIds: string[] | undefined,
): Set<string> {
  switch (runMode) {
    case "all":
      return new Set(chapter.pages.map((page) => page.id));
    case "single-page":
      return new Set(pageId ? [pageId] : []);
    case "page-set":
      return new Set(pageIds ?? []);
    default:
      return new Set(
        chapter.pages
          .filter((page) => page.analysisStatus !== "completed")
          .map((page) => page.id),
      );
  }
}
