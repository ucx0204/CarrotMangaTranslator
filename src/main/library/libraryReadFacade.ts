import { join } from "node:path";
import type { ChapterSnapshot, LibraryIndex } from "../../shared/libraryTypes";
import {
  listLibrary as listLibraryUnlocked,
  openChapter as openChapterUnlocked,
  resolvePagesForRun as resolvePagesForRunUnlocked,
} from "../libraryStore/libraryAccess";
import {
  findChapterLocation,
  type ChapterRunPaths,
} from "../libraryStore/libraryFiles";
import { getWorksRoot } from "../libraryStore/libraryPaths";
import { withLibraryNavigationRead } from "./lock";

export const listLibrary = createListLibrary(() =>
  withLibraryNavigationRead(listLibraryUnlocked),
);

export function createListLibrary(
  loadLibrary: () => Promise<LibraryIndex>,
): () => Promise<LibraryIndex> {
  let inFlight: Promise<LibraryIndex> | null = null;
  return () => {
    if (inFlight) {
      return inFlight;
    }
    const request = loadLibrary();
    inFlight = request;
    const clearIfCurrent = () => {
      if (inFlight === request) {
        inFlight = null;
      }
    };
    void request.then(clearIfCurrent, clearIfCurrent);
    return request;
  };
}

export async function openChapter(chapterId: string): Promise<ChapterSnapshot> {
  return withLibraryNavigationRead(() => openChapterUnlocked(chapterId));
}

export async function resolvePagesForRun(
  chapterId: string,
  runMode: Parameters<typeof resolvePagesForRunUnlocked>[1],
  pageId?: string,
  pageIds?: string[],
): Promise<Awaited<ReturnType<typeof resolvePagesForRunUnlocked>>> {
  return withLibraryNavigationRead(() =>
    resolvePagesForRunUnlocked(chapterId, runMode, pageId, pageIds),
  );
}

export function getRunPaths(
  chapterId: string,
  runId: string,
): Promise<ChapterRunPaths> {
  return withLibraryNavigationRead(async () => {
    const locator = await findChapterLocation(chapterId);
    if (!locator) {
      throw new Error("화를 찾지 못했습니다.");
    }
    const chapterDir = join(
      getWorksRoot(),
      locator.workId,
      "chapters",
      locator.chapterId,
    );
    const runDir = join(chapterDir, "runs", runId);
    return { chapterDir, runDir };
  });
}
