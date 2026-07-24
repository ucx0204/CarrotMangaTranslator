import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { LibraryPageRecord } from "../../shared/libraryTypes";
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
}: {
  workId: string;
  packageChapter: ChapterFile;
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  requestedTitle: string;
}): Promise<ChapterFile> {
  const now = new Date().toISOString();
  const chapterId = randomUUID();
  const chapterDir = join(getWorksRoot(), workId, "chapters", chapterId);
  const pagesDir = join(chapterDir, "pages");
  const inpaintedDir = join(chapterDir, "inpainted");
  try {
    await mkdir(pagesDir, { recursive: true });
    const pages = await materializeSharedPages({
      packageChapter,
      entries,
      archiveReader,
      pagesDir,
      inpaintedDir,
      now,
    });
    const chapter = buildMaterializedChapter({
      packageChapter,
      chapterId,
      workId,
      requestedTitle,
      pages,
      now,
    });
    await writeChapterFile(chapter);
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
}: {
  packageChapter: ChapterFile;
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  pagesDir: string;
  inpaintedDir: string;
  now: string;
}): Promise<LibraryPageRecord[]> {
  const pages: LibraryPageRecord[] = [];
  for (const [index, packagePage] of reorderRecords(
    packageChapter.pages,
    packageChapter.pageOrder,
  ).entries()) {
    pages.push(
      await materializeSharedPage({
        entries,
        archiveReader,
        packagePage,
        index,
        pagesDir,
        inpaintedDir,
        now,
      }),
    );
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
}: {
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  packagePage: LibraryPageRecord;
  index: number;
  pagesDir: string;
  inpaintedDir: string;
  now: string;
}): Promise<LibraryPageRecord> {
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
  });

  const inpaintedImagePath = await materializeSharedInpaintedImage({
    entries,
    archiveReader,
    packagePage,
    pageId,
    index,
    inpaintedDir,
  });
  const size = await readDecodedImportImageSize(outputPath, packagePage.name);
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
}: {
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  packagePage: LibraryPageRecord;
  pageId: string;
  index: number;
  inpaintedDir: string;
}): Promise<string | undefined> {
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

  await mkdir(inpaintedDir, { recursive: true });
  await writePackageImageEntry({
    entries,
    archiveReader,
    packageImagePath: packageInpaintedPath,
    outputPath,
    displayName: tMain("share.inpaintingResult", { page: packagePage.name }),
    missingMessage: tMain("share.errors.packageInpaintingMissing", {
      page: packagePage.name,
    }),
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
}: {
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  packageImagePath: string;
  outputPath: string;
  displayName: string;
  missingMessage: string;
}): Promise<void> {
  if (!isSupportedImagePath(packageImagePath)) {
    throw new Error(
      tMain("share.errors.unsupportedImage", { name: displayName }),
    );
  }

  const entry = entries.get(packageImagePath);
  if (!entry) {
    throw new Error(missingMessage);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const sourceExt = extname(packageImagePath).toLowerCase() || ".png";
  const sourceBytes = await archiveReader.readEntry(
    entry.entryName,
    MAX_SHARE_IMAGE_BYTES,
    packageImagePath,
  );
  if (shouldNormalizeImportImageToPng(sourceExt)) {
    const tempSourcePath = join(
      dirname(outputPath),
      `.${randomUUID()}.share-source${sourceExt}`,
    );
    try {
      await writeFile(tempSourcePath, sourceBytes);
      await writeNormalizedWebpImportImage(
        tempSourcePath,
        outputPath,
        displayName,
      );
    } finally {
      await unlinkIfExists(tempSourcePath);
    }
    return;
  }

  await writeFile(outputPath, sourceBytes);
}
