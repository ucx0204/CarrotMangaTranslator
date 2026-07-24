import type { ChapterSnapshot, LibraryIndex } from "../shared/libraryTypes";
import type {
  ChapterStoryMemory,
  PageStoryMemory,
} from "../shared/workContextTypes";
import { getChapterStoryMemory, listLibrary, openChapter } from "./library";
import { logWarn } from "./logger";

export type PreviousChapterContextRepository = {
  listLibrary: () => Promise<LibraryIndex>;
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  getChapterStoryMemory: (chapterId: string) => Promise<ChapterStoryMemory>;
};

export type PreviousChapterContextLogger = {
  warn: (message: string, detail?: unknown) => void;
};

type PreviousChapterContextDependencies = {
  repository: PreviousChapterContextRepository;
  logger: PreviousChapterContextLogger;
};

const defaultDependencies: PreviousChapterContextDependencies = {
  repository: { getChapterStoryMemory, listLibrary, openChapter },
  logger: { warn: logWarn },
};

export async function resolvePreviousChapterStoryPages(
  chapter: ChapterSnapshot,
  limit = Number.POSITIVE_INFINITY,
  dependencies: PreviousChapterContextDependencies = defaultDependencies,
): Promise<PageStoryMemory[]> {
  const library = await dependencies.repository.listLibrary();
  const work = library.works.find((entry) => entry.id === chapter.workId);
  if (!work || limit <= 0) return [];
  const currentIndex = work.chapters.findIndex(
    (entry) => entry.id === chapter.id,
  );
  if (currentIndex <= 0) return [];

  const previousChapters = work.chapters.slice(0, currentIndex);
  const memories = await Promise.all(
    previousChapters.map(async (summary) => ({
      summary,
      pages: await readLiveChapterMemory(summary.id, dependencies),
    })),
  );
  const chronological = memories.flatMap(({ summary, pages }) =>
    pages
      .slice()
      .sort((left, right) => left.pageIndex - right.pageIndex)
      .map((page) => ({ page, chapterTitle: summary.title })),
  );
  const selected = Number.isFinite(limit)
    ? chronological.slice(-Math.max(0, Math.floor(limit)))
    : chronological;
  return selected.map(({ page, chapterTitle }, index, pages) => ({
    ...page,
    pageName: `${chapterTitle} · ${page.pageName}`,
    pageIndex: index - pages.length,
  }));
}

async function readLiveChapterMemory(
  chapterId: string,
  { repository, logger }: PreviousChapterContextDependencies,
): Promise<PageStoryMemory[]> {
  try {
    const [chapter, memory] = await Promise.all([
      repository.openChapter(chapterId),
      repository.getChapterStoryMemory(chapterId),
    ]);
    const livePagesById = new Map(
      chapter.pages.map((page, pageIndex) => [page.id, { page, pageIndex }]),
    );
    return memory.pages.flatMap((page) => {
      const live = livePagesById.get(page.pageId);
      return live
        ? [{ ...page, pageName: live.page.name, pageIndex: live.pageIndex }]
        : [];
    });
  } catch (error) {
    logger.warn("Previous chapter story context could not be loaded", {
      chapterId,
      error,
    });
    return [];
  }
}
