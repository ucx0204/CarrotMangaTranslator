/* eslint-disable max-lines, max-lines-per-function -- shared image staging, final-path metadata, and validation stay co-located for transaction auditability */
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
  validateChapterFilePaths,
  writeChapterFile,
  type ChapterFile,
} from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import { tMain } from "./localization";
import { buildMaterializedSharedChapter } from "./shareImportChapterRecord";
import { buildMaterializedSharedPage } from "./shareImportPageRecord";
import {
  nativeImportDigest,
  observeNativeImportedPage,
  type NativeImportPageObservation,
  type NativeImportPageObserver,
  type NativeImportMetadataObserver,
} from "./importPublicationEvidence";
import { observeNativeImportedChapter } from "./importPublicationMetadata";
import {
  resolveSharedInpaintedOutputPath,
  resolveSharedPageOutputPath,
} from "./shareImportImagePaths";
import { isSupportedImagePath, unlinkIfExists, writeJsonFile } from "./storage";
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
  chapterId = randomUUID(),
  writeChapterDirectory,
  publishedChapterDirectory,
  observePage,
  observeMetadata,
  sourceChapterId = packageChapter.id,
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
  chapterId?: string;
  writeChapterDirectory?: string;
  publishedChapterDirectory?: string;
  observePage?: NativeImportPageObserver;
  observeMetadata?: NativeImportMetadataObserver;
  sourceChapterId?: string;
}): Promise<ChapterFile> {
  const now = new Date().toISOString();
  const { writeChapterDir, publishedChapterDir } =
    resolveSharedChapterDirectories(
      worksRoot,
      workId,
      chapterId,
      writeChapterDirectory,
      publishedChapterDirectory,
    );
  const pagesDir = join(writeChapterDir, "pages");
  const publishedPagesDir = join(publishedChapterDir, "pages");
  const inpaintedDir = join(writeChapterDir, "inpainted");
  const publishedInpaintedDir = join(publishedChapterDir, "inpainted");
  try {
    throwIfAborted(signal);
    await mkdir(pagesDir, { recursive: true });
    throwIfAborted(signal);
    const pages = await materializeSharedPages({
      packageChapter,
      entries,
      archiveReader,
      pagesDir,
      publishedPagesDir,
      inpaintedDir,
      publishedInpaintedDir,
      now,
      imageRuntime,
      signal,
      observation: observePage
        ? {
            observe: observePage,
            kind: "work-file",
            workId,
            chapterId,
            sourceChapterId,
          }
        : undefined,
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
    if (writeChapterDirectory) {
      await writeJsonFile(
        join(writeChapterDir, "chapter.json"),
        validateChapterFilePaths(workId, chapterId, chapter),
      );
    } else {
      await writeChapter(chapter);
    }
    if (observeMetadata)
      await observeNativeImportedChapter({
        workId,
        chapterId,
        directory: writeChapterDir,
        observe: observeMetadata,
        signal,
      });
    throwIfAborted(signal);
    return chapter;
  } catch (error) {
    if (!writeChapterDirectory) {
      await removeChapter(workId, chapterId);
    }
    throw error;
  }
}

function resolveSharedChapterDirectories(
  worksRoot: string,
  workId: string,
  chapterId: string,
  writeChapterDirectory?: string,
  publishedChapterDirectory?: string,
) {
  const defaultChapterDir = join(worksRoot, workId, "chapters", chapterId);
  const writeChapterDir = writeChapterDirectory ?? defaultChapterDir;
  const publishedChapterDir = publishedChapterDirectory ?? defaultChapterDir;
  if (
    (writeChapterDirectory === undefined) !==
    (publishedChapterDirectory === undefined)
  ) {
    throw new Error(
      "공유 import staging/published chapter 경로를 함께 지정해야 합니다.",
    );
  }
  return { writeChapterDir, publishedChapterDir };
}

async function materializeSharedPages({
  packageChapter,
  entries,
  archiveReader,
  pagesDir,
  publishedPagesDir,
  inpaintedDir,
  publishedInpaintedDir,
  now,
  imageRuntime,
  signal,
  observation,
}: {
  packageChapter: ChapterFile;
  entries: ReadonlyMap<string, ZipEntryLike>;
  archiveReader: ShareArchiveReader;
  pagesDir: string;
  publishedPagesDir: string;
  inpaintedDir: string;
  publishedInpaintedDir: string;
  now: string;
  imageRuntime: ImportImageRuntime;
  signal?: AbortSignal;
  observation?: NativeImportPageObservation;
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
        publishedPagesDir,
        inpaintedDir,
        publishedInpaintedDir,
        now,
        imageRuntime,
        signal,
        observation,
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
  publishedPagesDir,
  inpaintedDir,
  publishedInpaintedDir,
  now,
  imageRuntime,
  signal,
  observation,
}: {
  entries: ReadonlyMap<string, ZipEntryLike>;
  archiveReader: ShareArchiveReader;
  packagePage: LibraryPageRecord;
  index: number;
  pagesDir: string;
  publishedPagesDir: string;
  inpaintedDir: string;
  publishedInpaintedDir: string;
  now: string;
  imageRuntime: ImportImageRuntime;
  signal?: AbortSignal;
  observation?: NativeImportPageObservation;
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
  const publishedOutputPath = resolveSharedPageOutputPath(
    publishedPagesDir,
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
    publishedInpaintedDir,
    expectedDimensions: originalMetadata,
    imageRuntime,
    signal,
  });
  throwIfAborted(signal);
  const page = buildMaterializedSharedPage({
    packagePage,
    pageId,
    imagePath: publishedOutputPath,
    inpaintedImagePath: inpainted?.publishedPath,
    width: originalMetadata.width,
    height: originalMetadata.height,
    now,
  });
  if (observation)
    await observeNativeImportedPage({
      observation,
      page,
      pageIndex: index,
      sourcePageId: packagePage.id,
      source: {
        ...(await nativeImportDigest(originalPrepared.sourceBytes, signal)),
        format: originalPrepared.metadata.format,
      },
      sourceValue: originalPrepared.sourceBytes,
      inpaintedPath: inpainted?.path,
      originalPath: outputPath,
      originalFormat: originalMetadata.format,
      signal,
    });
  return page;
}

async function materializeSharedInpaintedImage({
  entries,
  archiveReader,
  packagePage,
  pageId,
  index,
  inpaintedDir,
  publishedInpaintedDir,
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
  publishedInpaintedDir: string;
  expectedDimensions: Pick<ImageHeaderMetadata, "width" | "height">;
  imageRuntime: ImportImageRuntime;
  signal?: AbortSignal;
}): Promise<
  | { path: string; publishedPath: string; metadata: ImageHeaderMetadata }
  | undefined
> {
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
  const publishedOutputPath = resolveSharedInpaintedOutputPath(
    publishedInpaintedDir,
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
  return { path: outputPath, publishedPath: publishedOutputPath, metadata };
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
