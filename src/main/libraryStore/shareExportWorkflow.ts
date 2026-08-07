import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { LibraryPageRecord } from "../../shared/libraryTypes";
import { throwIfAborted } from "../abortSignal";
import type {
  WorkShareExportRequest,
  WorkShareExportResult,
} from "../../shared/shareTypes";
import { tMain } from "./localization";
import { reorderRecords } from "./chapterRecords";
import {
  ensureExistingWork,
  readChapterFile,
  type ChapterFile,
} from "./libraryFiles";
import { readWorkStyleGuide } from "./workContextFiles";
import {
  SHARE_FORMAT,
  SHARE_VERSION,
  type ShareManifest,
} from "./sharePackage";
import {
  writeAtomicStreamingShareArchive,
  type StreamingShareArchiveWriter,
} from "./shareStreamingZip";
import { isSupportedImagePath } from "./storage";
import { MAX_SHARE_IMAGE_BYTES } from "./zipSafety";

export async function exportWorkShareToFile(
  request: WorkShareExportRequest & { outputPath: string },
  signal?: AbortSignal,
): Promise<WorkShareExportResult> {
  throwIfAborted(signal);
  const work = await ensureExistingWork(request.workId);
  throwIfAborted(signal);
  const requestedIds = new Set(request.chapterIds);
  const chapterIds = work.chapterOrder.filter((chapterId) =>
    requestedIds.has(chapterId),
  );
  if (chapterIds.length === 0) {
    throw new Error(tMain("share.errors.selectChapter"));
  }

  const exportedAt = new Date();
  const manifest: ShareManifest = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    exportedAt: exportedAt.toISOString(),
    work: {
      id: work.id,
      title: work.title,
    },
    chapterOrder: chapterIds,
  };

  const counts = await writeAtomicStreamingShareArchive(
    {
      outputPath: request.outputPath,
      archiveDate: exportedAt,
      signal,
    },
    async (archive) => {
      await archive.addJson("manifest.json", manifest);
      throwIfAborted(signal);

      const styleGuide = await readWorkStyleGuide(work.id);
      throwIfAborted(signal);
      await archive.addJson("style-guide.json", styleGuide);

      let pageCount = 0;
      for (const chapterId of chapterIds) {
        throwIfAborted(signal);
        pageCount += await addChapterToShare(
          archive,
          work.id,
          chapterId,
          signal,
        );
      }
      return { pageCount };
    },
  );

  return {
    filePath: request.outputPath,
    workTitle: work.title,
    chapterCount: chapterIds.length,
    pageCount: counts.pageCount,
  };
}

async function addChapterToShare(
  archive: StreamingShareArchiveWriter,
  workId: string,
  chapterId: string,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const chapter = await readChapterFile(workId, chapterId);
  throwIfAborted(signal);
  if (!chapter) {
    throw new Error(tMain("share.errors.exportChapterNotFound"));
  }

  const packagePages: LibraryPageRecord[] = [];
  const orderedPages = reorderRecords(chapter.pages, chapter.pageOrder);
  for (const [pageIndex, page] of orderedPages.entries()) {
    throwIfAborted(signal);
    const packagePage = await addPageToShare(
      archive,
      chapter.id,
      page,
      pageIndex,
      signal,
    );
    packagePages.push(packagePage);
  }

  const packageChapter: ChapterFile = {
    ...chapter,
    pageOrder: orderedPages.map((page) => page.id),
    pages: packagePages,
  };
  await archive.addJson(`chapters/${chapter.id}/chapter.json`, packageChapter);
  return packagePages.length;
}

async function addPageToShare(
  archive: StreamingShareArchiveWriter,
  chapterId: string,
  page: LibraryPageRecord,
  pageIndex: number,
  signal?: AbortSignal,
): Promise<LibraryPageRecord> {
  throwIfAborted(signal);
  const imageExt = extname(page.imagePath).toLowerCase() || ".png";
  const packageImagePath = `chapters/${chapterId}/pages/${String(pageIndex + 1).padStart(3, "0")}-${page.id}${imageExt}`;
  await addImageFileToShare({
    archive,
    sourcePath: page.imagePath,
    packagePath: packageImagePath,
    displayName: page.name,
    missingMessage: tMain("share.errors.sourceImageMissing", {
      page: page.name,
    }),
    signal,
  });
  return {
    ...page,
    imagePath: packageImagePath,
    inpaintedImagePath: await addInpaintedPageToShare(
      archive,
      chapterId,
      page,
      pageIndex,
      signal,
    ),
  };
}

async function addInpaintedPageToShare(
  archive: StreamingShareArchiveWriter,
  chapterId: string,
  page: LibraryPageRecord,
  pageIndex: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  throwIfAborted(signal);
  if (!page.inpaintedImagePath) {
    return undefined;
  }
  const inpaintedExt = extname(page.inpaintedImagePath).toLowerCase() || ".png";
  const packagePath = `chapters/${chapterId}/inpainted/${String(pageIndex + 1).padStart(3, "0")}-${page.id}-inpainted${inpaintedExt}`;
  await addImageFileToShare({
    archive,
    sourcePath: page.inpaintedImagePath,
    packagePath,
    displayName: tMain("share.inpaintingResult", { page: page.name }),
    missingMessage: tMain("share.errors.inpaintingImageMissing", {
      page: page.name,
    }),
    signal,
  });
  return packagePath;
}

async function addImageFileToShare({
  archive,
  sourcePath,
  packagePath,
  displayName,
  missingMessage,
  signal,
}: {
  archive: StreamingShareArchiveWriter;
  sourcePath: string;
  packagePath: string;
  displayName: string;
  missingMessage: string;
  signal?: AbortSignal;
}): Promise<void> {
  const source = await resolveShareImageSource({
    sourcePath,
    packagePath,
    displayName,
    missingMessage,
    signal,
  });
  throwIfAborted(signal);
  await archive.addFile(packagePath, source);
  throwIfAborted(signal);
}

async function resolveShareImageSource({
  sourcePath,
  packagePath,
  displayName,
  missingMessage,
  signal,
}: {
  sourcePath: string;
  packagePath: string;
  displayName: string;
  missingMessage: string;
  signal?: AbortSignal;
}): Promise<{ path: string; size: number }> {
  throwIfAborted(signal);
  if (!isSupportedImagePath(sourcePath) || !isSupportedImagePath(packagePath)) {
    throw new Error(
      tMain("share.errors.unsupportedImage", { name: displayName }),
    );
  }

  let sourceStat: Awaited<ReturnType<typeof stat>>;
  try {
    sourceStat = await stat(sourcePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new Error(missingMessage, { cause: error });
    }
    throw error;
  }
  throwIfAborted(signal);

  if (!sourceStat.isFile()) {
    throw new Error(missingMessage);
  }
  if (sourceStat.size > MAX_SHARE_IMAGE_BYTES) {
    throw new Error(tMain("share.errors.fileTooLarge", { name: displayName }));
  }

  return {
    path: sourcePath,
    size: sourceStat.size,
  };
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
