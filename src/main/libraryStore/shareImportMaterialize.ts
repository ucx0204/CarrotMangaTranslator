import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { LibraryPageRecord } from "../../shared/libraryTypes";
import { throwIfAborted } from "../abortSignal";
import { tMain } from "./localization";
import { reorderRecords, resolveChapterStatus } from "./chapterRecords";
import {
  readDecodedImportImageSize,
  shouldNormalizeImportImageToPng,
  writeNormalizedWebpImportImage,
} from "./importImages";
import {
  removeChapterDirectory,
  writeChapterFile,
  type ChapterFile,
} from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import { isSupportedImagePath, unlinkIfExists } from "./storage";
import {
  MAX_SHARE_IMAGE_BYTES,
  normalizeShareRelativePath,
  type ZipArchiveReader,
  type ZipEntryLike,
} from "./zipSafety";

export async function materializeSharedChapter({
  workId,
  packageChapter,
  entries,
  archiveReader,
  requestedTitle,
  signal,
}: {
  workId: string;
  packageChapter: ChapterFile;
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  requestedTitle: string;
  signal?: AbortSignal;
}): Promise<ChapterFile> {
  const now = new Date().toISOString();
  const chapterId = randomUUID();
  const chapterDir = join(getWorksRoot(), workId, "chapters", chapterId);
  const pagesDir = join(chapterDir, "pages");
  const inpaintedDir = join(chapterDir, "inpainted");
  try {
    throwIfAborted(signal);
    await mkdir(pagesDir, { recursive: true });
    throwIfAborted(signal);
    const pages = await materializeSharedPages({
      packageChapter,
      entries,
      archiveReader,
      pagesDir,
      inpaintedDir,
      now,
      signal,
    });
    const chapter = buildMaterializedChapter({
      packageChapter,
      chapterId,
      workId,
      requestedTitle,
      pages,
      now,
    });
    throwIfAborted(signal);
    await writeChapterFile(chapter);
    throwIfAborted(signal);
    return chapter;
  } catch (error) {
    await removeChapterDirectory(workId, chapterId);
    throw error;
  }
}

async function materializeSharedPages({
  packageChapter,
  entries,
  archiveReader,
  pagesDir,
  inpaintedDir,
  now,
  signal,
}: {
  packageChapter: ChapterFile;
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  pagesDir: string;
  inpaintedDir: string;
  now: string;
  signal?: AbortSignal;
}): Promise<LibraryPageRecord[]> {
  const pages: LibraryPageRecord[] = [];
  for (const [index, packagePage] of reorderRecords(
    packageChapter.pages,
    packageChapter.pageOrder,
  ).entries()) {
    throwIfAborted(signal);
    pages.push(
      await materializeSharedPage({
        entries,
        archiveReader,
        packagePage,
        index,
        pagesDir,
        inpaintedDir,
        now,
        signal,
      }),
    );
    throwIfAborted(signal);
  }
  return pages;
}

async function materializeSharedPage({
  entries,
  archiveReader,
  packagePage,
  index,
  pagesDir,
  inpaintedDir,
  now,
  signal,
}: {
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  packagePage: LibraryPageRecord;
  index: number;
  pagesDir: string;
  inpaintedDir: string;
  now: string;
  signal?: AbortSignal;
}): Promise<LibraryPageRecord> {
  throwIfAborted(signal);
  const packageImagePath = normalizeShareRelativePath(
    packagePage.imagePath,
    tMain("share.errors.invalidImagePath"),
  );
  const pageId = randomUUID();
  const outputPath = resolveSharedPageOutputPath(
    pagesDir,
    packageImagePath,
    pageId,
    index,
  );

  await writePackageImageEntry({
    entries,
    archiveReader,
    packageImagePath,
    outputPath,
    displayName: packagePage.name,
    missingMessage: tMain("share.errors.packageImageMissing", {
      page: packagePage.name,
    }),
    signal,
  });
  throwIfAborted(signal);

  const inpaintedImagePath = await materializeSharedInpaintedImage({
    entries,
    archiveReader,
    packagePage,
    pageId,
    index,
    inpaintedDir,
    signal,
  });
  throwIfAborted(signal);
  const size = await readDecodedImportImageSize(outputPath, packagePage.name);
  throwIfAborted(signal);
  return {
    ...packagePage,
    id: pageId,
    imagePath: outputPath,
    inpaintedImagePath,
    width: size.width || packagePage.width || 1000,
    height: size.height || packagePage.height || 1400,
    blocks: packagePage.blocks.map((block, blockIndex) => ({
      ...block,
      id: `${pageId}-block-${blockIndex + 1}`,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

function resolveSharedPageOutputPath(
  pagesDir: string,
  packageImagePath: string,
  pageId: string,
  index: number,
): string {
  const sourceExt = extname(packageImagePath).toLowerCase() || ".png";
  const targetExt = shouldNormalizeImportImageToPng(sourceExt)
    ? ".png"
    : sourceExt;
  return join(
    pagesDir,
    `${String(index + 1).padStart(3, "0")}-${pageId}${targetExt}`,
  );
}

function buildMaterializedChapter({
  packageChapter,
  chapterId,
  workId,
  requestedTitle,
  pages,
  now,
}: {
  packageChapter: ChapterFile;
  chapterId: string;
  workId: string;
  requestedTitle: string;
  pages: LibraryPageRecord[];
  now: string;
}): ChapterFile {
  return {
    ...packageChapter,
    id: chapterId,
    workId,
    title: requestedTitle,
    status: resolveChapterStatus(pages),
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: now,
    updatedAt: now,
  };
}

async function materializeSharedInpaintedImage({
  entries,
  archiveReader,
  packagePage,
  pageId,
  index,
  inpaintedDir,
  signal,
}: {
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  packagePage: LibraryPageRecord;
  pageId: string;
  index: number;
  inpaintedDir: string;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  throwIfAborted(signal);
  if (!packagePage.inpaintedImagePath) {
    return undefined;
  }

  const packageInpaintedPath = normalizeShareRelativePath(
    packagePage.inpaintedImagePath,
    tMain("share.errors.invalidInpaintingPath"),
  );
  const outputPath = resolveSharedInpaintedOutputPath(
    inpaintedDir,
    packageInpaintedPath,
    pageId,
    index,
  );

  throwIfAborted(signal);
  await mkdir(inpaintedDir, { recursive: true });
  throwIfAborted(signal);
  await writePackageImageEntry({
    entries,
    archiveReader,
    packageImagePath: packageInpaintedPath,
    outputPath,
    displayName: tMain("share.inpaintingResult", { page: packagePage.name }),
    missingMessage: tMain("share.errors.packageInpaintingMissing", {
      page: packagePage.name,
    }),
    signal,
  });
  return outputPath;
}

function resolveSharedInpaintedOutputPath(
  inpaintedDir: string,
  packageInpaintedPath: string,
  pageId: string,
  index: number,
): string {
  const sourceExt = extname(packageInpaintedPath).toLowerCase() || ".png";
  const targetExt = shouldNormalizeImportImageToPng(sourceExt)
    ? ".png"
    : sourceExt;
  return join(
    inpaintedDir,
    `${String(index + 1).padStart(3, "0")}-${pageId}-inpainted${targetExt}`,
  );
}

async function writePackageImageEntry({
  entries,
  archiveReader,
  packageImagePath,
  outputPath,
  displayName,
  missingMessage,
  signal,
}: {
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  packageImagePath: string;
  outputPath: string;
  displayName: string;
  missingMessage: string;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(signal);
  if (!isSupportedImagePath(packageImagePath)) {
    throw new Error(
      tMain("share.errors.unsupportedImage", { name: displayName }),
    );
  }

  const entry = entries.get(packageImagePath);
  if (!entry) {
    throw new Error(missingMessage);
  }

  throwIfAborted(signal);
  await mkdir(dirname(outputPath), { recursive: true });
  throwIfAborted(signal);
  const sourceExt = extname(packageImagePath).toLowerCase() || ".png";
  const sourceBytes = await archiveReader.readEntry(
    entry.entryName,
    MAX_SHARE_IMAGE_BYTES,
    packageImagePath,
  );
  throwIfAborted(signal);
  if (shouldNormalizeImportImageToPng(sourceExt)) {
    const tempSourcePath = join(
      dirname(outputPath),
      `.${randomUUID()}.share-source${sourceExt}`,
    );
    try {
      throwIfAborted(signal);
      await writeFile(tempSourcePath, sourceBytes, { signal });
      throwIfAborted(signal);
      await writeNormalizedWebpImportImage(
        tempSourcePath,
        outputPath,
        displayName,
        undefined,
        signal,
      );
    } finally {
      await unlinkIfExists(tempSourcePath);
    }
    return;
  }

  throwIfAborted(signal);
  await writeFile(outputPath, sourceBytes, { signal });
  throwIfAborted(signal);
}
