import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { LibraryPageRecord } from "../../shared/types";
import { reorderRecords, resolveChapterStatus } from "./chapterRecords";
import {
  readDecodedImportImageSize,
  shouldNormalizeImportImageToPng,
  writeNormalizedWebpImportImage,
} from "./importImages";
import {
  WORKS_ROOT,
  removeChapterDirectory,
  writeChapterFile,
  type ChapterFile,
} from "./libraryFiles";
import { isSupportedImagePath, safeUnlink } from "./storage";
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
  const chapterDir = join(WORKS_ROOT, workId, "chapters", chapterId);
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
    "페이지 이미지 경로가 올바르지 않습니다.",
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
    missingMessage: `공유 파일에 이미지가 없습니다: ${packagePage.name}`,
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
    "인페인팅 결과 이미지 경로가 올바르지 않습니다.",
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
    displayName: `${packagePage.name} 인페인팅 결과`,
    missingMessage: `공유 파일에 인페인팅 결과 이미지가 없습니다: ${packagePage.name}`,
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
    throw new Error(`지원하지 않는 이미지 형식입니다: ${displayName}`);
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
      await safeUnlink(tempSourcePath);
    }
    return;
  }

  await writeFile(outputPath, sourceBytes);
}
