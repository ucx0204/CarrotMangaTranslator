import { throwIfAborted } from "../abortSignal";
import type {
  WorkShareImportFromPackageRequest,
  WorkShareImportPreviewView,
  WorkShareImportResult,
} from "../../shared/shareTypes";
import { tMain } from "./localization";
import { hydrateChapter } from "./chapterSnapshots";
import {
  createWork,
  removeChapterDirectory,
  removeWorkFromIndexAndDisk,
  writeWorkFile,
  type ChapterFile,
  type WorkFile,
} from "./libraryFiles";
import { importWorkShareIntoExistingWork } from "./shareImportExistingWorkflow";
import { materializeSharedChapter } from "./shareImportMaterialize";
import { writeWorkStyleGuide } from "./workContextFiles";
import {
  assertPackageOnlyEntries,
  readSharePackage,
  type SharePackage,
} from "./sharePackage";
import { makeUniqueTitleInList, sanitizeTitle } from "./titles";
import { openZipArchiveReader, type ZipArchiveReader } from "./zipSafety";

export async function previewWorkShareImport(
  packagePath: string,
): Promise<WorkShareImportPreviewView> {
  const sharePackage = await readSharePackage(packagePath);
  return {
    workTitle: sharePackage.manifest.work.title,
    chapters: sharePackage.chapters.map(({ packageChapterId, chapter }) => ({
      packageChapterId,
      title: chapter.title,
      pageCount: chapter.pages.length,
    })),
  };
}

export async function importWorkShareUnlocked(
  request: WorkShareImportFromPackageRequest,
  signal?: AbortSignal,
): Promise<WorkShareImportResult> {
  throwIfAborted(signal);
  const sharePackage = await readSharePackage(request.packagePath);
  throwIfAborted(signal);
  const archiveReader = await openZipArchiveReader(
    request.packagePath,
    tMain("share.fileLabel"),
  );

  try {
    throwIfAborted(signal);
    if (request.entries.length === 0) {
      throw new Error(tMain("share.errors.noChapters"));
    }

    throwIfAborted(signal);
    if (request.target.mode === "new") {
      return await importWorkShareAsNewWork(
        sharePackage,
        archiveReader,
        request,
        signal,
      );
    }

    return await importWorkShareIntoExistingWork(
      sharePackage,
      archiveReader,
      request,
      signal,
    );
  } finally {
    archiveReader.close();
  }
}

async function importWorkShareAsNewWork(
  sharePackage: SharePackage,
  archiveReader: ZipArchiveReader,
  request: WorkShareImportFromPackageRequest,
  signal?: AbortSignal,
): Promise<WorkShareImportResult> {
  if (request.target.mode !== "new") {
    throw new Error(tMain("share.errors.notNewWorkRequest"));
  }
  assertPackageOnlyEntries(request.entries);

  let work: WorkFile | null = null;
  const chapterByPackageId = new Map(
    sharePackage.chapters.map((item) => [item.packageChapterId, item.chapter]),
  );
  const usedTitles = new Set<string>();
  const createdChapters: ChapterFile[] = [];

  try {
    throwIfAborted(signal);
    work = await createWork(
      request.target.title || sharePackage.manifest.work.title,
    );
    throwIfAborted(signal);

    for (const entry of request.entries) {
      throwIfAborted(signal);
      const packageChapter = chapterByPackageId.get(entry.packageChapterId);
      if (!packageChapter) {
        throw new Error(tMain("share.errors.chapterNotFound"));
      }
      const title = makeUniqueTitleInList(
        sanitizeTitle(
          entry.title || packageChapter.title,
          tMain("import.untitled"),
        ),
        usedTitles,
      );
      const chapter = await materializeSharedChapter({
        workId: work.id,
        packageChapter,
        entries: sharePackage.entries,
        archiveReader,
        requestedTitle: title,
        signal,
      });
      createdChapters.push(chapter);
      throwIfAborted(signal);
    }

    if (createdChapters.length === 0) {
      throw new Error(tMain("share.errors.noChapters"));
    }

    const chapterIds = createdChapters.map((chapter) => chapter.id);
    work.chapterOrder = chapterIds;
    work.updatedAt = new Date().toISOString();
    throwIfAborted(signal);
    await writeWorkFile(work);
    if (sharePackage.styleGuide) {
      throwIfAborted(signal);
      await writeWorkStyleGuide({
        ...sharePackage.styleGuide,
        workId: work.id,
      });
    }

    const openedChapter = createdChapters[0];
    if (!openedChapter) {
      throw new Error(tMain("share.errors.importedChapterOpen"));
    }

    return {
      workId: work.id,
      chapterIds,
      openedChapter: hydrateChapter(openedChapter),
    };
  } catch (error) {
    for (const chapter of createdChapters) {
      await removeChapterDirectory(chapter.workId, chapter.id);
    }
    if (work) {
      await removeWorkFromIndexAndDisk(work.id);
    }
    throw error;
  }
}
