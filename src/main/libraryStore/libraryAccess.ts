import type {
  ChapterSnapshot,
  LibraryChapterSummary,
  LibraryIndex,
  LibraryWorkSummary,
  MangaPage,
} from "../../shared/libraryTypes";
import { hydrateChapter } from "./chapterSnapshots";
import { readChapterSummaryFile } from "./libraryChapterSummaries";
import {
  findChapterLocation,
  readChapterFile,
  readIndexFile,
  readWorkFile,
} from "./libraryFiles";

export async function listLibrary(): Promise<LibraryIndex> {
  const index = await readIndexFile();
  const workCandidates = await Promise.all(
    index.workOrder.map(loadLibraryWorkSummary),
  );
  const works = workCandidates.filter(
    (work): work is LibraryWorkSummary => work !== null,
  );

  return {
    workOrder: works.map((work) => work.id),
    works,
  };
}

async function loadLibraryWorkSummary(
  workId: string,
): Promise<LibraryWorkSummary | null> {
  const work = await readWorkFile(workId);
  if (!work) {
    return null;
  }
  const chapterCandidates = await Promise.all(
    work.chapterOrder.map((chapterId) =>
      readChapterSummaryFile(workId, chapterId),
    ),
  );
  const chapters = chapterCandidates.filter(
    (chapter): chapter is LibraryChapterSummary => chapter !== null,
  );
  return { ...work, chapters };
}

export async function openChapter(chapterId: string): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("열려는 화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("열려는 화를 찾지 못했습니다.");
  }
  return hydrateChapter(chapter);
}

export async function resolvePagesForRun(
  chapterId: string,
  runMode: "pending" | "all" | "single-page" | "page-set",
  pageId?: string,
  pageIds?: string[],
): Promise<{
  chapter: ChapterSnapshot;
  pages: MangaPage[];
}> {
  const chapter = await openChapter(chapterId);
  return {
    chapter,
    pages: selectRunPages(chapter, runMode, pageId, pageIds),
  };
}

function selectRunPages(
  chapter: ChapterSnapshot,
  runMode: "pending" | "all" | "single-page" | "page-set",
  pageId: string | undefined,
  pageIds: string[] | undefined,
): MangaPage[] {
  switch (runMode) {
    case "all":
      return chapter.pages;
    case "single-page":
      return chapter.pages.filter((page) => page.id === pageId);
    case "page-set": {
      const ids = new Set(pageIds ?? []);
      return chapter.pages.filter((page) => ids.has(page.id));
    }
    default:
      return chapter.pages.filter(
        (page) => page.analysisStatus !== "completed",
      );
  }
}
