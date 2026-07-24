import { reorderRecordsByIdOrder } from "../lib/appHelpers";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";

export function isSameStringOrder(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

export function reorderChapterSummaries(
  library: LibraryIndex,
  workId: string,
  nextOrder: string[],
): LibraryIndex {
  return {
    ...library,
    works: library.works.map((candidate) =>
      candidate.id === workId
        ? {
            ...candidate,
            chapterOrder: nextOrder,
            chapters: reorderRecordsByIdOrder(candidate.chapters, nextOrder),
          }
        : candidate,
    ),
  };
}

export function rollbackChapterSummaries(
  library: LibraryIndex,
  workId: string,
  optimisticOrder: string[],
  previousOrder: string[],
): LibraryIndex {
  return {
    ...library,
    works: library.works.map((candidate) =>
      candidate.id === workId &&
      isSameStringOrder(candidate.chapterOrder, optimisticOrder)
        ? {
            ...candidate,
            chapterOrder: previousOrder,
            chapters: reorderRecordsByIdOrder(
              candidate.chapters,
              previousOrder,
            ),
          }
        : candidate,
    ),
  };
}

export function reorderChapterPages(
  chapter: ChapterSnapshot,
  nextOrder: string[],
): ChapterSnapshot {
  return {
    ...chapter,
    pageOrder: nextOrder,
    pages: reorderRecordsByIdOrder(chapter.pages, nextOrder),
  };
}
