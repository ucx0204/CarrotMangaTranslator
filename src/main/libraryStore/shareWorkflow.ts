import type {
  WorkShareImportFromPackageRequest,
  WorkShareImportPreviewView,
  WorkShareImportResult,
} from "../../shared/types";
import { tMain } from "./localization";
import { hydrateChapter } from "./chapterSnapshots";
import {
  createWork,
  removeChapterDirectory,
  removeWorkFromIndexAndDisk,
  writeWorkFile,
  type ChapterFile,
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

export { exportWorkShareToFile } from "./shareExportWorkflow";

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
): Promise<WorkShareImportResult> {
  const sharePackage = await readSharePackage(request.packagePath);
  const archiveReader = await openZipArchiveReader(
    request.packagePath,
    tMain("share.fileLabel"),
  );
  if (request.entries.length === 0) {
    archiveReader.close();
    throw new Error(tMain("share.errors.noChapters"));
  }

  try {
    if (request.target.mode === "new") {
      return await importWorkShareAsNewWork(
        sharePackage,
        archiveReader,
        request,
      );
    }

    return await importWorkShareIntoExistingWork(
      sharePackage,
      archiveReader,
      request,
    );
  } finally {
    archiveReader.close();
  }
}

async function importWorkShareAsNewWork(
  sharePackage: SharePackage,
  archiveReader: ZipArchiveReader,
  request: WorkShareImportFromPackageRequest,
): Promise<WorkShareImportResult> {
  if (request.target.mode !== "new") {
    throw new Error(tMain("share.errors.notNewWorkRequest"));
  }
  assertPackageOnlyEntries(request.entries);

  const work = await createWork(
    request.target.title || sharePackage.manifest.work.title,
  );
  const chapterByPackageId = new Map(
    sharePackage.chapters.map((item) => [item.packageChapterId, item.chapter]),
  );
  const usedTitles = new Set<string>();
  const createdChapters: ChapterFile[] = [];

  try {
    for (const entry of request.entries) {
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
      });
      createdChapters.push(chapter);
    }

    if (createdChapters.length === 0) {
      throw new Error(tMain("share.errors.noChapters"));
    }

    const chapterIds = createdChapters.map((chapter) => chapter.id);
    work.chapterOrder = chapterIds;
    work.updatedAt = new Date().toISOString();
    await writeWorkFile(work);
    if (sharePackage.styleGuide) {
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
    await removeWorkFromIndexAndDisk(work.id);
    throw error;
  }
}
