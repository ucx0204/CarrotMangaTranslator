import type { LibraryPageRecord } from "../../shared/libraryTypes";
import { resolveChapterStatus } from "./chapterRecords";
import type { ChapterFile } from "./libraryFiles";

export function buildMaterializedSharedChapter({
  packageChapter,
  chapterId,
  workId,
  requestedTitle,
  pages,
  now,
}: {
  packageChapter: ChapterFile;
  chapterId: string;
  workId: string;
  requestedTitle: string;
  pages: LibraryPageRecord[];
  now: string;
}): ChapterFile {
  return {
    ...packageChapter,
    id: chapterId,
    workId,
    title: requestedTitle,
    status: resolveChapterStatus(pages),
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: now,
    updatedAt: now,
  };
}
