import type {
  ChapterSnapshot,
  MangaPage,
  RunMode,
} from "../../../shared/libraryTypes";

type ChapterSelection = {
  selectedPageId: string | null;
  selectedBlockId: string | null;
};

export type LiveChapterMergeResult = {
  chapter: ChapterSnapshot;
  preservedDirtyPageIds: string[];
};

export type LiveChapterMergeOptions = {
  /**
   * 라이브 챕터에만 존재하는 새 블록(예: 영역 번역 결과)을 dirty로 보존된
   * 로컬 페이지에도 덧붙인다. 지정하지 않으면 dirty 페이지의 블록은 로컬
   * 상태 그대로 유지된다.
   */
  appendLiveBlocks?: {
    pageId: string;
    blockIds: string[];
  };
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
  options: LiveChapterMergeOptions = {},
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
          blocks: mergeAppendedLiveBlocks(localPage, page, options),
          inpaintedImagePath: page.inpaintedImagePath,
          analysisStatus: page.analysisStatus,
          lastError: page.lastError,
        };
      }),
    },
    preservedDirtyPageIds,
  };
}

function mergeAppendedLiveBlocks(
  localPage: MangaPage,
  livePage: MangaPage,
  options: LiveChapterMergeOptions,
): MangaPage["blocks"] {
  const appendLiveBlocks = options.appendLiveBlocks;
  if (!appendLiveBlocks || appendLiveBlocks.pageId !== livePage.id) {
    return localPage.blocks;
  }
  const appendIds = new Set(appendLiveBlocks.blockIds);
  const localIds = new Set(localPage.blocks.map((block) => block.id));
  const appended = livePage.blocks.filter(
    (block) => appendIds.has(block.id) && !localIds.has(block.id),
  );
  return appended.length
    ? [...localPage.blocks, ...appended]
    : localPage.blocks;
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
