import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
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
import { isSupportedImagePath } from "./storage";
import { AdmZip, MAX_SHARE_IMAGE_BYTES } from "./zipSafety";

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

  const zip = new AdmZip();
  const manifest: ShareManifest = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    exportedAt: new Date().toISOString(),
    work: {
      id: work.id,
      title: work.title,
    },
    chapterOrder: chapterIds,
  };

  zip.addFile(
    "manifest.json",
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  );
  throwIfAborted(signal);
  const styleGuide = await readWorkStyleGuide(work.id);
  throwIfAborted(signal);
  zip.addFile(
    "style-guide.json",
    Buffer.from(`${JSON.stringify(styleGuide, null, 2)}\n`, "utf8"),
  );

  let pageCount = 0;
  for (const chapterId of chapterIds) {
    throwIfAborted(signal);
    pageCount += await addChapterToShare(zip, work.id, chapterId, signal);
    throwIfAborted(signal);
  }

  throwIfAborted(signal);
  await mkdir(dirname(request.outputPath), { recursive: true });
  throwIfAborted(signal);
  zip.writeZip(request.outputPath);
  throwIfAborted(signal);

  return {
    filePath: request.outputPath,
    workTitle: work.title,
    chapterCount: chapterIds.length,
    pageCount,
  };
}

async function addChapterToShare(
  zip: { addFile: (entryName: string, content: Buffer | string) => void },
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
    packagePages.push(
      await addPageToShare(zip, chapter.id, page, pageIndex, signal),
    );
    throwIfAborted(signal);
  }

  const packageChapter: ChapterFile = {
    ...chapter,
    pageOrder: orderedPages.map((page) => page.id),
    pages: packagePages,
  };
  zip.addFile(
    `chapters/${chapter.id}/chapter.json`,
    Buffer.from(`${JSON.stringify(packageChapter, null, 2)}\n`, "utf8"),
  );
  return packagePages.length;
}

async function addPageToShare(
  zip: { addFile: (entryName: string, content: Buffer | string) => void },
  chapterId: string,
  page: LibraryPageRecord,
  pageIndex: number,
  signal?: AbortSignal,
): Promise<LibraryPageRecord> {
  throwIfAborted(signal);
  const imageExt = extname(page.imagePath).toLowerCase() || ".png";
  const packageImagePath = `chapters/${chapterId}/pages/${String(pageIndex + 1).padStart(3, "0")}-${page.id}${imageExt}`;
  await addImageFileToShare({
    zip,
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
      zip,
      chapterId,
      page,
      pageIndex,
      signal,
    ),
  };
}

async function addInpaintedPageToShare(
  zip: { addFile: (entryName: string, content: Buffer | string) => void },
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
    zip,
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
  zip,
  sourcePath,
  packagePath,
  displayName,
  missingMessage,
  signal,
}: {
  zip: { addFile: (entryName: string, content: Buffer | string) => void };
  sourcePath: string;
  packagePath: string;
  displayName: string;
  missingMessage: string;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(signal);
  if (!existsSync(sourcePath)) {
    throw new Error(missingMessage);
  }
  if (!isSupportedImagePath(sourcePath) || !isSupportedImagePath(packagePath)) {
    throw new Error(
      tMain("share.errors.unsupportedImage", { name: displayName }),
    );
  }
  throwIfAborted(signal);
  const sourceStat = await stat(sourcePath);
  throwIfAborted(signal);
  if (sourceStat.size > MAX_SHARE_IMAGE_BYTES) {
    throw new Error(tMain("share.errors.fileTooLarge", { name: displayName }));
  }
  throwIfAborted(signal);
  const sourceBytes = await readFile(sourcePath, { signal });
  throwIfAborted(signal);
  zip.addFile(packagePath, sourceBytes);
}
