import { join } from "node:path";
import type {
  ChapterSnapshot,
  CreateImportFromPreviewRequest,
  CreateImportResult,
  LibraryIndex,
  MangaPage,
  SavePageBlocksRequest,
  WorkShareExportRequest,
  WorkShareExportResult,
  WorkShareImportFromPackageRequest,
  WorkShareImportResult,
} from "../shared/types";
import {
  listLibrary as listLibraryUnlocked,
  openChapter as openChapterUnlocked,
  resolvePagesForRun as resolvePagesForRunUnlocked,
} from "./libraryStore/libraryAccess";
import {
  cleanupLibraryOrphansUnlocked,
  findChapterLocation,
  getLibraryRoot,
  assertLibraryImagePath,
  WORKS_ROOT,
  type ChapterRunPaths,
  type LibraryCleanupResult,
} from "./libraryStore/libraryFiles";
import { createImportFromPreviewUnlocked } from "./libraryStore/importWorkflow";
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
} from "./libraryStore/libraryMutations";
import { AsyncReaderWriterLock } from "./libraryStore/mutex";
import {
  exportWorkShareToFile as exportWorkShareToFileUnlocked,
  importWorkShareUnlocked,
} from "./libraryStore/shareWorkflow";

export { pathExists } from "./libraryStore/storage";
export {
  previewFolder,
  previewImages,
  previewZip,
  previewZipFolder,
} from "./libraryStore/importWorkflow";
export { previewWorkShareImport } from "./libraryStore/shareWorkflow";
export { assertLibraryImagePath, getLibraryRoot };
export type {
  ChapterRunPaths,
  LibraryCleanupResult,
} from "./libraryStore/libraryFiles";

const libraryLock = new AsyncReaderWriterLock();

function withLibraryMutation<T>(operation: () => Promise<T>): Promise<T> {
  return libraryLock.runWrite(operation);
}

function withLibraryRead<T>(operation: () => Promise<T>): Promise<T> {
  return libraryLock.runRead(operation);
}

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
): Promise<Awaited<ReturnType<typeof resolvePagesForRunUnlocked>>> {
  return withLibraryRead(() =>
    resolvePagesForRunUnlocked(chapterId, runMode, pageId),
  );
}

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

export async function createImport(
  request: CreateImportFromPreviewRequest,
): Promise<CreateImportResult> {
  return withLibraryMutation(() => createImportFromPreviewUnlocked(request));
}

export async function importWorkShare(
  request: WorkShareImportFromPackageRequest,
): Promise<WorkShareImportResult> {
  return withLibraryMutation(() => importWorkShareUnlocked(request));
}

export async function exportWorkShareToFile(
  request: WorkShareExportRequest & { outputPath: string },
): Promise<WorkShareExportResult> {
  return withLibraryRead(() => exportWorkShareToFileUnlocked(request));
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

export async function cleanupLibraryOrphans(): Promise<LibraryCleanupResult> {
  return withLibraryMutation(cleanupLibraryOrphansUnlocked);
}
