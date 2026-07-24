import { join, resolve } from "node:path";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { withLibraryMutation } from "../library/lock";
import { openChapter as openChapterUnlocked } from "../libraryStore/libraryAccess";
import { removeUnreferencedInpaintedArtifacts } from "../libraryStore/inpaintedArtifacts";
import { findChapterLocation } from "../libraryStore/libraryFiles";
import { getWorksRoot } from "../libraryStore/libraryPaths";
import {
  updatePagesAfterInpaintingUnlocked,
  type InpaintingArtifactCleanupOptions,
} from "../libraryStore/libraryInpaintingMutations";
import {
  readCurrentChapterAfterRollbackFailure,
  validateChangePaths,
  type InpaintingRevisionChange,
} from "./inpaintingRevisionHelpers";

type RevisionArtifactCleanupRequest = {
  chapterId: string;
  changes: InpaintingRevisionChange[];
  retainedPaths: string[];
};

export type InpaintingRevisionRepository = {
  runMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  readChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  readChapterAfterRollbackFailure: (
    chapterId: string,
  ) => Promise<ChapterSnapshot | undefined>;
  savePages: (
    chapterId: string,
    pages: MangaPage[],
    cleanupOptions: InpaintingArtifactCleanupOptions,
  ) => Promise<ChapterSnapshot>;
  cleanupReleasedArtifacts: (
    request: RevisionArtifactCleanupRequest,
  ) => Promise<void>;
  validateChangePaths: (
    chapter: ChapterSnapshot,
    change: InpaintingRevisionChange,
  ) => void;
};

export const libraryInpaintingRevisionRepository: InpaintingRevisionRepository =
  {
    runMutation: withLibraryMutation,
    readChapter: openChapterUnlocked,
    readChapterAfterRollbackFailure: readCurrentChapterAfterRollbackFailure,
    savePages: updatePagesAfterInpaintingUnlocked,
    cleanupReleasedArtifacts: cleanupReleasedArtifactsFromLibrary,
    validateChangePaths,
  };

async function cleanupReleasedArtifactsFromLibrary({
  chapterId,
  changes,
  retainedPaths,
}: RevisionArtifactCleanupRequest): Promise<void> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    return;
  }
  const chapter = await openChapterUnlocked(chapterId);
  const candidates = changes.flatMap((change) =>
    [change.beforePath, change.afterPath].filter((path): path is string =>
      Boolean(path),
    ),
  );
  await removeUnreferencedInpaintedArtifacts(
    resolve(
      join(getWorksRoot(), locator.workId, "chapters", locator.chapterId),
    ),
    candidates,
    chapter.pages,
    retainedPaths,
  );
}
