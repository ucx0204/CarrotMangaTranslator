import { randomUUID } from "node:crypto";
import { copyFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ImportPageDraft } from "../../shared/importTypes";
import type { LibraryPageRecord } from "../../shared/libraryTypes";
import type { ImportImageRuntime } from "./importImageRuntime";
import { tMain } from "./localization";
import {
  assertImportImageFileBudget,
  detectImportImageFormat,
  detectImportImageFormatFromFile,
  readDecodedImportImageSize,
  shouldNormalizeImportImageToPng,
  writeNormalizedWebpImportImage,
  type ImportImageFormat,
} from "./importImages";
import { unlinkIfExists } from "./storage";
import {
  MAX_IMPORT_IMAGE_BYTES,
  openZipArchiveReader,
  type ZipArchiveReader,
} from "./zipSafety";

type PreparedImportPageImage =
  | {
      kind: "file";
      sourceExt: string;
      detectedFormat: ImportImageFormat | null;
    }
  | {
      kind: "zip-entry";
      sourceExt: string;
      detectedFormat: ImportImageFormat | null;
      sourceBytes: Buffer;
    };

export async function materializePageRecord(
  pageDraft: ImportPageDraft,
  pagesDir: string,
  index: number,
  zipReaderCache: Map<string, ZipArchiveReader>,
  imageRuntime: ImportImageRuntime,
): Promise<LibraryPageRecord> {
  const pageId = randomUUID();
  const preparedImage = await prepareImportedPageImage(
    pageDraft,
    zipReaderCache,
  );
  const outputPath = resolveImportOutputPath(
    pagesDir,
    index,
    pageId,
    resolveImportOutputExt(
      preparedImage.sourceExt,
      preparedImage.detectedFormat,
    ),
  );

  await writeImportedPageImage(
    pageDraft,
    pagesDir,
    pageId,
    preparedImage,
    outputPath,
    imageRuntime,
  );

  const size = await readDecodedImportImageSize(
    outputPath,
    pageDraft.name,
    imageRuntime,
  );
  const now = new Date().toISOString();

  return {
    id: pageId,
    name: pageDraft.name,
    imagePath: outputPath,
    width: size.width || 1000,
    height: size.height || 1400,
    blocks: [],
    analysisStatus: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

async function writeImportedPageImage(
  pageDraft: ImportPageDraft,
  pagesDir: string,
  pageId: string,
  preparedImage: PreparedImportPageImage,
  outputPath: string,
  imageRuntime: ImportImageRuntime,
): Promise<void> {
  if (preparedImage.kind === "zip-entry") {
    await writeZipImportedPageImage(
      pageDraft,
      pagesDir,
      pageId,
      preparedImage,
      outputPath,
      imageRuntime,
    );
    return;
  }
  await writeFileImportedPageImage(
    pageDraft,
    preparedImage,
    outputPath,
    imageRuntime,
  );
}

async function writeZipImportedPageImage(
  pageDraft: ImportPageDraft,
  pagesDir: string,
  pageId: string,
  preparedImage: Extract<PreparedImportPageImage, { kind: "zip-entry" }>,
  outputPath: string,
  imageRuntime: ImportImageRuntime,
): Promise<void> {
  if (!shouldNormalizePreparedImage(preparedImage)) {
    await writeFile(outputPath, preparedImage.sourceBytes);
    return;
  }
  await writeNormalizedZipImportImage(
    pageDraft,
    pagesDir,
    pageId,
    outputPath,
    preparedImage.sourceBytes,
    imageRuntime,
  );
}

async function writeNormalizedZipImportImage(
  pageDraft: ImportPageDraft,
  pagesDir: string,
  pageId: string,
  outputPath: string,
  sourceBytes: Buffer,
  imageRuntime: ImportImageRuntime,
): Promise<void> {
  const tempSourcePath = join(pagesDir, `.${pageId}.import-source.webp`);
  try {
    await writeFile(tempSourcePath, sourceBytes);
    await writeNormalizedWebpImportImage(
      tempSourcePath,
      outputPath,
      pageDraft.name,
      imageRuntime,
    );
  } finally {
    await unlinkIfExists(tempSourcePath);
  }
}

async function writeFileImportedPageImage(
  pageDraft: ImportPageDraft,
  preparedImage: Extract<PreparedImportPageImage, { kind: "file" }>,
  outputPath: string,
  imageRuntime: ImportImageRuntime,
): Promise<void> {
  if (shouldNormalizePreparedImage(preparedImage)) {
    await writeNormalizedWebpImportImage(
      pageDraft.sourcePath,
      outputPath,
      pageDraft.name,
      imageRuntime,
    );
    return;
  }
  await copyFile(pageDraft.sourcePath, outputPath);
}

async function prepareImportedPageImage(
  pageDraft: ImportPageDraft,
  zipReaderCache: Map<string, ZipArchiveReader>,
): Promise<PreparedImportPageImage> {
  const sourceExt = resolveImportSourceExt(pageDraft);
  if (pageDraft.sourceKind !== "zip-entry") {
    await assertImportImageFileBudget(pageDraft.sourcePath);
    return {
      kind: "file",
      sourceExt,
      detectedFormat: await detectImportImageFormatFromFile(
        pageDraft.sourcePath,
      ),
    };
  }

  const reader = await getCachedZipReader(pageDraft.sourcePath, zipReaderCache);
  const entry = reader.entryMap.get(pageDraft.zipEntryName ?? "");
  if (!entry) {
    throw new Error(
      tMain("import.errors.zipEntryMissing", {
        entry: pageDraft.zipEntryName ?? pageDraft.sourcePath,
      }),
    );
  }
  const sourceBytes = await reader.readEntry(
    entry.entryName,
    MAX_IMPORT_IMAGE_BYTES,
    pageDraft.zipEntryName ?? pageDraft.sourcePath,
  );
  return {
    kind: "zip-entry",
    sourceExt,
    detectedFormat: detectImportImageFormat(sourceBytes),
    sourceBytes,
  };
}

function shouldNormalizePreparedImage(image: PreparedImportPageImage): boolean {
  return (
    image.detectedFormat === "webp" ||
    (image.detectedFormat === null &&
      shouldNormalizeImportImageToPng(image.sourceExt))
  );
}

function resolveImportOutputExt(
  sourceExt: string,
  detectedFormat: ImportImageFormat | null,
): string {
  if (detectedFormat === "webp" || detectedFormat === "png") {
    return ".png";
  }
  if (detectedFormat === "jpeg") {
    return sourceExt === ".jpeg" ? ".jpeg" : ".jpg";
  }
  return shouldNormalizeImportImageToPng(sourceExt) ? ".png" : sourceExt;
}

function resolveImportSourceExt(pageDraft: ImportPageDraft): string {
  return pageDraft.sourceKind === "zip-entry"
    ? extname(pageDraft.zipEntryName ?? "").toLowerCase() || ".png"
    : extname(pageDraft.sourcePath).toLowerCase() || ".png";
}

function resolveImportOutputPath(
  pagesDir: string,
  index: number,
  pageId: string,
  targetExt: string,
): string {
  return join(
    pagesDir,
    `${String(index + 1).padStart(3, "0")}-${pageId}${targetExt}`,
  );
}

async function getCachedZipReader(
  zipPath: string,
  cache: Map<string, ZipArchiveReader>,
): Promise<ZipArchiveReader> {
  const cached = cache.get(zipPath);
  if (cached) {
    return cached;
  }
  const reader = await openZipArchiveReader(zipPath, tMain("import.zipFile"));
  cache.set(zipPath, reader);
  return reader;
}
