import type {
  PageImageExportChapterSelection,
  PageImageExportRequest,
} from "../../shared/pageImageExportTypes";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { PageImageExportRepository } from "./pageImageExportPorts";
import { tMain } from "./localization";

type ResolvedExportPage = {
  page: MangaPage;
  pageIndex: number;
};

type ResolvedExportChapter = {
  chapter: ChapterSnapshot;
  chapterIndex: number;
  pages: ResolvedExportPage[];
};

export type ResolvedPageImageExport = {
  workTitle: string;
  chapters: ResolvedExportChapter[];
  pageCount: number;
};

export async function resolvePageImageExportSelection(
  request: PageImageExportRequest,
  repository: PageImageExportRepository,
): Promise<ResolvedPageImageExport> {
  const library = await repository.listLibrary();
  const work = library.works.find(
    (candidate) => candidate.id === request.workId,
  );
  if (!work) {
    throw new Error(tMain("export.errors.workNotFound"));
  }

  const selections = validateUniqueChapterSelections(request.selections);
  const chapterIds = new Set(work.chapters.map((chapter) => chapter.id));
  for (const chapterId of selections.keys()) {
    if (!chapterIds.has(chapterId)) {
      throw new Error(tMain("export.errors.chapterNotFound"));
    }
  }

  const chapters = await resolveSelectedChapters({
    chapterOrder: work.chapterOrder,
    selections,
    repository,
    workId: work.id,
  });
  const pageCount = chapters.reduce(
    (total, chapter) => total + chapter.pages.length,
    0,
  );
  if (pageCount === 0) {
    throw new Error(tMain("export.noPages"));
  }
  return { workTitle: work.title, chapters, pageCount };
}

async function resolveSelectedChapters({
  chapterOrder,
  selections,
  repository,
  workId,
}: {
  chapterOrder: string[];
  selections: Map<string, PageImageExportChapterSelection>;
  repository: PageImageExportRepository;
  workId: string;
}): Promise<ResolvedExportChapter[]> {
  const chapters: ResolvedExportChapter[] = [];
  for (const [chapterIndex, chapterId] of chapterOrder.entries()) {
    const selection = selections.get(chapterId);
    if (!selection) {
      continue;
    }
    const chapter = await repository.openChapter(chapterId);
    if (chapter.workId !== workId) {
      throw new Error(tMain("export.errors.chapterNotFound"));
    }
    const pages = resolveChapterPages(chapter, selection);
    if (pages.length > 0) {
      chapters.push({ chapter, chapterIndex, pages });
    }
  }
  return chapters;
}

function validateUniqueChapterSelections(
  selections: PageImageExportChapterSelection[],
): Map<string, PageImageExportChapterSelection> {
  const result = new Map<string, PageImageExportChapterSelection>();
  for (const selection of selections) {
    if (result.has(selection.chapterId)) {
      throw new Error(tMain("export.errors.duplicateChapter"));
    }
    result.set(selection.chapterId, selection);
  }
  return result;
}

function resolveChapterPages(
  chapter: ChapterSnapshot,
  selection: PageImageExportChapterSelection,
): ResolvedExportPage[] {
  if (selection.mode === "all") {
    return chapter.pages.map((page, pageIndex) => ({ page, pageIndex }));
  }

  const pageIds = new Set<string>();
  for (const pageId of selection.pageIds) {
    if (pageIds.has(pageId)) {
      throw new Error(tMain("export.errors.duplicatePage"));
    }
    pageIds.add(pageId);
  }
  const knownPageIds = new Set(chapter.pages.map((page) => page.id));
  for (const pageId of pageIds) {
    if (!knownPageIds.has(pageId)) {
      throw new Error(tMain("export.errors.pageNotFound"));
    }
  }
  return chapter.pages.flatMap((page, pageIndex) =>
    pageIds.has(page.id) ? [{ page, pageIndex }] : [],
  );
}
