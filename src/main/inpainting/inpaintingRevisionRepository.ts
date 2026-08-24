import { join, resolve } from "node:path";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { withLibraryMutation } from "../library/lock";
import { openChapter as openChapterUnlocked } from "../libraryStore/libraryAccess";
import {
  removeUnreferencedInpaintMaskArtifacts,
  removeUnreferencedInpaintedArtifacts,
} from "../libraryStore/inpaintedArtifacts";
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
  const inpaintedCandidates = changes.flatMap((change) =>
    [change.beforePath, change.afterPath].filter((path): path is string =>
      Boolean(path),
    ),
  );
  const maskCandidates = changes.flatMap((change) =>
    [change.beforeMaskPath, change.afterMaskPath].filter(
      (path): path is string => Boolean(path),
    ),
  );
  const chapterDir = resolve(
    join(getWorksRoot(), locator.workId, "chapters", locator.chapterId),
  );
  await removeUnreferencedInpaintedArtifacts(
    chapterDir,
    inpaintedCandidates,
    chapter.pages,
    retainedPaths,
  );
  await removeUnreferencedInpaintMaskArtifacts(
    chapterDir,
    maskCandidates,
    chapter.pages,
    retainedPaths,
  );
}
