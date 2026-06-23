import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../../shared/libraryTypes";
import type { SavePageBlocksRequest } from "../../shared/shareTypes";
import {
  cleanupLibraryOrphansUnlocked,
  type LibraryCleanupResult,
} from "../libraryStore/libraryCleanup";
import {
  deleteChapterUnlocked,
  deletePageUnlocked,
  deleteWorkUnlocked,
  finalizeRunningPagesUnlocked,
  markChapterPagesRunningUnlocked,
  renameChapterUnlocked,
  renameWorkUnlocked,
  reorderChaptersUnlocked,
  reorderPagesUnlocked,
  savePageBlocksUnlocked,
  setPageInpaintingResultUnlocked,
  updatePageAfterAnalysisUnlocked,
  updatePagesAfterAnalysisUnlocked,
  updatePagesAfterInpaintingUnlocked,
  type InpaintingArtifactCleanupOptions,
  type PageAnalysisUpdate,
} from "../libraryStore/libraryMutations";
import { withLibraryMutation } from "./lock";

export async function savePageBlocks(
  request: SavePageBlocksRequest,
): Promise<ChapterSnapshot> {
  return withLibraryMutation(() => savePageBlocksUnlocked(request));
}

export async function renameWork(
  workId: string,
  title: string,
): Promise<LibraryIndex> {
  return withLibraryMutation(() => renameWorkUnlocked(workId, title));
}

export async function renameChapter(
  chapterId: string,
  title: string,
): Promise<LibraryIndex> {
  return withLibraryMutation(() => renameChapterUnlocked(chapterId, title));
}

export async function deleteWork(workId: string): Promise<LibraryIndex> {
  return withLibraryMutation(() => deleteWorkUnlocked(workId));
}

export async function deleteChapter(chapterId: string): Promise<LibraryIndex> {
  return withLibraryMutation(() => deleteChapterUnlocked(chapterId));
}

export async function reorderChapters(
  workId: string,
  chapterIds: string[],
): Promise<LibraryIndex> {
  return withLibraryMutation(() => reorderChaptersUnlocked(workId, chapterIds));
}

export async function reorderPages(
  chapterId: string,
  pageIds: string[],
): Promise<ChapterSnapshot> {
  return withLibraryMutation(() => reorderPagesUnlocked(chapterId, pageIds));
}

export async function deletePage(
  chapterId: string,
  pageId: string,
): Promise<ChapterSnapshot> {
  return withLibraryMutation(() => deletePageUnlocked(chapterId, pageId));
}

export async function markChapterPagesRunning(
  chapterId: string,
  pageIds: string[],
): Promise<ChapterSnapshot> {
  return withLibraryMutation(() =>
    markChapterPagesRunningUnlocked(chapterId, pageIds),
  );
}

export async function updatePageAfterAnalysis(
  chapterId: string,
  page: MangaPage,
  warnings: string[],
  status: "completed" | "failed",
  expectedUpdatedAt?: string,
): Promise<void> {
  return withLibraryMutation(() =>
    updatePageAfterAnalysisUnlocked(
      chapterId,
      page,
      warnings,
      status,
      expectedUpdatedAt,
    ),
  );
}

export async function updatePagesAfterAnalysis(
  chapterId: string,
  updates: PageAnalysisUpdate[],
): Promise<void> {
  return withLibraryMutation(() =>
    updatePagesAfterAnalysisUnlocked(chapterId, updates),
  );
}

export async function finalizeRunningPages(
  chapterId: string,
  pageIds: string[],
  status: "idle" | "failed",
  errorMessage?: string,
): Promise<void> {
  return withLibraryMutation(() =>
    finalizeRunningPagesUnlocked(chapterId, pageIds, status, errorMessage),
  );
}

export async function updatePagesAfterInpainting(
  chapterId: string,
  pages: MangaPage[],
  cleanupOptions?: InpaintingArtifactCleanupOptions,
): Promise<ChapterSnapshot> {
  return withLibraryMutation(() =>
    updatePagesAfterInpaintingUnlocked(chapterId, pages, cleanupOptions),
  );
}

export async function setPageInpaintingResult(
  chapterId: string,
  pageId: string,
  inpaintedImagePath?: string | null,
  cleanupOptions?: InpaintingArtifactCleanupOptions,
): Promise<ChapterSnapshot> {
  return withLibraryMutation(() =>
    setPageInpaintingResultUnlocked(
      chapterId,
      pageId,
      inpaintedImagePath,
      cleanupOptions,
    ),
  );
}

export async function cleanupLibraryOrphans(): Promise<LibraryCleanupResult> {
  return withLibraryMutation(cleanupLibraryOrphansUnlocked);
}
