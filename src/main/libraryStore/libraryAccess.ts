import type { ChapterSnapshot, LibraryChapterSummary, LibraryIndex, LibraryWorkSummary, MangaPage } from "../../shared/types";
import { hydrateChapter } from "./chapterSnapshots";
import { toChapterSummary } from "./chapterRecords";
import { findChapterLocation, readChapterFile, readIndexFile, readWorkFile } from "./libraryFiles";

export async function listLibrary(): Promise<LibraryIndex> {
  const index = await readIndexFile();
  const works: LibraryWorkSummary[] = [];

  for (const workId of index.workOrder) {
    const work = await readWorkFile(workId);
    if (!work) {
      continue;
    }
    const chapters: LibraryChapterSummary[] = [];
    for (const chapterId of work.chapterOrder) {
      const chapter = await readChapterFile(workId, chapterId);
      if (!chapter) {
        continue;
      }
      chapters.push(toChapterSummary(chapter));
    }
    works.push({ ...work, chapters });
  }

  return {
    workOrder: works.map((work) => work.id),
    works
  };
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
  runMode: "pending" | "all" | "single-page",
  pageId?: string
): Promise<{
  chapter: ChapterSnapshot;
  pages: MangaPage[];
}> {
  const chapter = await openChapter(chapterId);
  const pages =
    runMode === "all"
      ? chapter.pages
      : runMode === "single-page"
        ? chapter.pages.filter((page) => page.id === pageId)
        : chapter.pages.filter((page) => page.analysisStatus !== "completed");

  return {
    chapter,
    pages
  };
}
