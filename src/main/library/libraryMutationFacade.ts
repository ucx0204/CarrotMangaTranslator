import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../../shared/libraryTypes";
import type { PageRevision } from "../../shared/pageRevision";
import type {
  SavePageBlocksRequest,
  SavePagesBlocksRequest,
} from "../../shared/shareTypes";
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
  updatePageAfterAnalysisUnlocked,
  updatePagesAfterAnalysisUnlocked,
  type PageAnalysisUpdate,
} from "../libraryStore/libraryMutations";
import {
  savePageBlocksUnlocked,
  savePagesBlocksUnlocked,
} from "../libraryStore/libraryPageBlockMutations";
import { appendAnalyzedPageBlocksUnlocked } from "../libraryStore/libraryAnalysisMutations";
import {
  setPageInpaintingResultUnlocked,
  updatePagesAfterInpaintingUnlocked,
  type InpaintingArtifactCleanupOptions,
} from "../libraryStore/libraryInpaintingMutations";
import { withLibraryMutation } from "./lock";

export type SavePageBlocksRuntime = {
  runMutation: typeof withLibraryMutation;
  savePageBlocks: typeof savePageBlocksUnlocked;
};

const productionSavePageBlocksRuntime: SavePageBlocksRuntime = {
  runMutation: withLibraryMutation,
  savePageBlocks: savePageBlocksUnlocked,
};

export function createSavePageBlocks(runtime: SavePageBlocksRuntime) {
  return (request: SavePageBlocksRequest): Promise<ChapterSnapshot> =>
    runtime.runMutation(() => runtime.savePageBlocks(request));
}

export const savePageBlocks = createSavePageBlocks(
  productionSavePageBlocksRuntime,
);

export type SavePagesBlocksRuntime = {
  runMutation: typeof withLibraryMutation;
  savePagesBlocks: typeof savePagesBlocksUnlocked;
};

const productionSavePagesBlocksRuntime: SavePagesBlocksRuntime = {
  runMutation: withLibraryMutation,
  savePagesBlocks: savePagesBlocksUnlocked,
};

export function createSavePagesBlocks(runtime: SavePagesBlocksRuntime) {
  return (request: SavePagesBlocksRequest): Promise<ChapterSnapshot> =>
    runtime.runMutation(() => runtime.savePagesBlocks(request));
}

export const savePagesBlocks = createSavePagesBlocks(
  productionSavePagesBlocksRuntime,
);

export async function appendAnalyzedPageBlocks(
  chapterId: string,
  pageId: string,
  blocks: MangaPage["blocks"],
): Promise<ChapterSnapshot> {
  return withLibraryMutation(() =>
    appendAnalyzedPageBlocksUnlocked(chapterId, pageId, blocks),
  );
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
  expectedRevision?: PageRevision,
): Promise<boolean> {
  return withLibraryMutation(() =>
    updatePageAfterAnalysisUnlocked(
      chapterId,
      page,
      warnings,
      status,
      expectedUpdatedAt,
      expectedRevision,
    ),
  );
}

export async function updatePagesAfterAnalysis(
  chapterId: string,
  updates: PageAnalysisUpdate[],
): Promise<ReadonlySet<string>> {
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
