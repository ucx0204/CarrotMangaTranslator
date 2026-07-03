import { join } from "node:path";
import type { ChapterSnapshot, LibraryIndex } from "../../shared/libraryTypes";
import {
  listLibrary as listLibraryUnlocked,
  openChapter as openChapterUnlocked,
  resolvePagesForRun as resolvePagesForRunUnlocked,
} from "../libraryStore/libraryAccess";
import {
  findChapterLocation,
  WORKS_ROOT,
  type ChapterRunPaths,
} from "../libraryStore/libraryFiles";
import { withLibraryRead } from "./lock";

export async function listLibrary(): Promise<LibraryIndex> {
  return withLibraryRead(listLibraryUnlocked);
}

export async function openChapter(chapterId: string): Promise<ChapterSnapshot> {
  return withLibraryRead(() => openChapterUnlocked(chapterId));
}

export async function resolvePagesForRun(
  chapterId: string,
  runMode: Parameters<typeof resolvePagesForRunUnlocked>[1],
  pageId?: string,
  pageIds?: string[],
): Promise<Awaited<ReturnType<typeof resolvePagesForRunUnlocked>>> {
  return withLibraryRead(() =>
    resolvePagesForRunUnlocked(chapterId, runMode, pageId, pageIds),
  );
}

export function getRunPaths(
  chapterId: string,
  runId: string,
): Promise<ChapterRunPaths> {
  return withLibraryRead(async () => {
    const locator = await findChapterLocation(chapterId);
    if (!locator) {
      throw new Error("화를 찾지 못했습니다.");
    }
    const chapterDir = join(
      WORKS_ROOT,
      locator.workId,
      "chapters",
      locator.chapterId,
    );
    const runDir = join(chapterDir, "runs", runId);
    return { chapterDir, runDir };
  });
}
