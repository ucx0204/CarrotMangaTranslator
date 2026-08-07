import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { LibraryPageRecord } from "../../shared/libraryTypes";
import { throwIfAborted } from "../abortSignal";
import { reorderRecords } from "./chapterRecords";
import {
  assertSameImageDimensions,
  probeImageBuffer,
  type ImageHeaderMetadata,
} from "./imageHeaderProbe";
import {
  convertValidatedWebpImportImage,
  validateStoredImportImage,
} from "./importImages";
import {
  productionImportImageRuntime,
  type ImportImageRuntime,
} from "./importImageRuntime";
import {
  removeChapterDirectory,
  writeChapterFile,
  type ChapterFile,
} from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import { tMain } from "./localization";
import { buildMaterializedSharedChapter } from "./shareImportChapterRecord";
import {
  resolveSharedInpaintedOutputPath,
  resolveSharedPageOutputPath,
} from "./shareImportImagePaths";
import { isSupportedImagePath, unlinkIfExists } from "./storage";
import {
  MAX_SHARE_IMAGE_BYTES,
  normalizeShareRelativePath,
  type ZipArchiveReader,
  type ZipEntryLike,
} from "./zipSafety";

type ShareArchiveReader = Pick<ZipArchiveReader, "readEntry">;

type PreparedPackageImage = {
  sourceBytes: Buffer;
  sourceExt: string;
  metadata: ImageHeaderMetadata;
};

export async function materializeSharedChapter({
  workId,
  packageChapter,
  entries,
  archiveReader,
  requestedTitle,
  signal,
  worksRoot = getWorksRoot(),
  imageRuntime = productionImportImageRuntime,
  writeChapter = writeChapterFile,
  removeChapter = removeChapterDirectory,
}: {
  workId: string;
  packageChapter: ChapterFile;
  entries: ReadonlyMap<string, ZipEntryLike>;
  archiveReader: ShareArchiveReader;
  requestedTitle: string;
  signal?: AbortSignal;
  worksRoot?: string;
  imageRuntime?: ImportImageRuntime;
  writeChapter?: typeof writeChapterFile;
  removeChapter?: typeof removeChapterDirectory;
}): Promise<ChapterFile> {
  const now = new Date().toISOString();
  const chapterId = randomUUID();
  const chapterDir = join(worksRoot, workId, "chapters", chapterId);
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
      imageRuntime,
      signal,
    });
    const chapter = buildMaterializedSharedChapter({
      packageChapter,
      chapterId,
      workId,
      requestedTitle,
      pages,
      now,
    });
    throwIfAborted(signal);
    await writeChapter(chapter);
    throwIfAborted(signal);
    return chapter;
  } catch (error) {
    await removeChapter(workId, chapterId);
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
  imageRuntime,
  signal,
}: {
  packageChapter: ChapterFile;
  entries: ReadonlyMap<string, ZipEntryLike>;
  archiveReader: ShareArchiveReader;
  pagesDir: string;
  inpaintedDir: string;
  now: string;
  imageRuntime: ImportImageRuntime;
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
        imageRuntime,
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
  imageRuntime,
  signal,
}: {
  entries: ReadonlyMap<string, ZipEntryLike>;
  archiveReader: ShareArchiveReader;
  packagePage: LibraryPageRecord;
  index: number;
  pagesDir: string;
  inpaintedDir: string;
  now: string;
  imageRuntime: ImportImageRuntime;
  signal?: AbortSignal;
}): Promise<LibraryPageRecord> {
  throwIfAborted(signal);
  const packageImagePath = normalizeShareRelativePath(
    packagePage.imagePath,
    tMain("share.errors.invalidImagePath"),
  );
  const originalPrepared = await preparePackageImageEntry({
    entries,
    archiveReader,
    packageImagePath,
    displayName: packagePage.name,
    missingMessage: tMain("share.errors.packageImageMissing", {
      page: packagePage.name,
    }),
    signal,
  });
  throwIfAborted(signal);

  const pageId = randomUUID();
  const outputPath = resolveSharedPageOutputPath(
    pagesDir,
    originalPrepared.sourceExt,
    originalPrepared.metadata.format,
    pageId,
    index,
  );
  const originalMetadata = await writePackageImageEntry({
    prepared: originalPrepared,
    outputPath,
    displayName: packagePage.name,
    imageRuntime,
    signal,
  });
  throwIfAborted(signal);

  const inpainted = await materializeSharedInpaintedImage({
    entries,
    archiveReader,
    packagePage,
    pageId,
    index,
    inpaintedDir,
    expectedDimensions: originalMetadata,
    imageRuntime,
    signal,
  });
  throwIfAborted(signal);
  return {
    ...packagePage,
    id: pageId,
    imagePath: outputPath,
    inpaintedImagePath: inpainted?.path,
    width: originalMetadata.width,
    height: originalMetadata.height,
    blocks: packagePage.blocks.map((block, blockIndex) => ({
      ...block,
      id: `${pageId}-block-${blockIndex + 1}`,
    })),
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
  expectedDimensions,
  imageRuntime,
  signal,
}: {
  entries: ReadonlyMap<string, ZipEntryLike>;
  archiveReader: ShareArchiveReader;
  packagePage: LibraryPageRecord;
  pageId: string;
  index: number;
  inpaintedDir: string;
  expectedDimensions: Pick<ImageHeaderMetadata, "width" | "height">;
  imageRuntime: ImportImageRuntime;
  signal?: AbortSignal;
}): Promise<{ path: string; metadata: ImageHeaderMetadata } | undefined> {
  throwIfAborted(signal);
  if (!packagePage.inpaintedImagePath) {
    return undefined;
  }

  const packageInpaintedPath = normalizeShareRelativePath(
    packagePage.inpaintedImagePath,
    tMain("share.errors.invalidInpaintingPath"),
  );
  const displayName = tMain("share.inpaintingResult", {
    page: packagePage.name,
  });
  const prepared = await preparePackageImageEntry({
    entries,
    archiveReader,
    packageImagePath: packageInpaintedPath,
    displayName,
    missingMessage: tMain("share.errors.packageInpaintingMissing", {
      page: packagePage.name,
    }),
    signal,
  });
  throwIfAborted(signal);
  const outputPath = resolveSharedInpaintedOutputPath(
    inpaintedDir,
    prepared.sourceExt,
    prepared.metadata.format,
    pageId,
    index,
  );

  await mkdir(inpaintedDir, { recursive: true });
  throwIfAborted(signal);
  const metadata = await writePackageImageEntry({
    prepared,
    outputPath,
    displayName,
    imageRuntime,
    signal,
  });
  assertSameImageDimensions(
    expectedDimensions,
    metadata,
    tMain("share.errors.inpaintingDimensionsMismatch", {
      page: packagePage.name,
    }),
  );
  return { path: outputPath, metadata };
}

async function preparePackageImageEntry({
  entries,
  archiveReader,
  packageImagePath,
  displayName,
  missingMessage,
  signal,
}: {
  entries: ReadonlyMap<string, ZipEntryLike>;
  archiveReader: ShareArchiveReader;
  packageImagePath: string;
  displayName: string;
  missingMessage: string;
  signal?: AbortSignal;
}): Promise<PreparedPackageImage> {
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
  const sourceBytes = await archiveReader.readEntry(
    entry.entryName,
    MAX_SHARE_IMAGE_BYTES,
    packageImagePath,
  );
  throwIfAborted(signal);
  const metadata = probeImageBuffer(sourceBytes, displayName);
  return {
    sourceBytes,
    sourceExt: extname(packageImagePath).toLowerCase() || ".png",
    metadata,
  };
}

async function writePackageImageEntry({
  prepared,
  outputPath,
  displayName,
  imageRuntime,
  signal,
}: {
  prepared: PreparedPackageImage;
  outputPath: string;
  displayName: string;
  imageRuntime: ImportImageRuntime;
  signal?: AbortSignal;
}): Promise<ImageHeaderMetadata> {
  try {
    throwIfAborted(signal);
    await mkdir(dirname(outputPath), { recursive: true });
    throwIfAborted(signal);
    if (prepared.metadata.format === "webp") {
      const tempSourcePath = join(
        dirname(outputPath),
        `.${randomUUID()}.share-source.webp`,
      );
      try {
        await writeFile(tempSourcePath, prepared.sourceBytes, { signal });
        throwIfAborted(signal);
        return await convertValidatedWebpImportImage({
          sourcePath: tempSourcePath,
          outputPath,
          sourceMetadata: prepared.metadata,
          label: displayName,
          runtime: imageRuntime,
          signal,
        });
      } finally {
        await unlinkIfExists(tempSourcePath);
      }
    }

    await writeFile(outputPath, prepared.sourceBytes, { signal });
    throwIfAborted(signal);
    return await validateStoredImportImage({
      imagePath: outputPath,
      expected: prepared.metadata,
      label: displayName,
      runtime: imageRuntime,
      signal,
    });
  } catch (error) {
    await unlinkIfExists(outputPath);
    throw error;
  }
}
