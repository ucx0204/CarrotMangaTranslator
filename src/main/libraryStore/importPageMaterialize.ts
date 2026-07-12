import { randomUUID } from "node:crypto";
import { copyFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ImportPageDraft } from "../../shared/importTypes";
import type { LibraryPageRecord } from "../../shared/libraryTypes";
import { tMain } from "./localization";
import {
  assertImportImageFileBudget,
  readDecodedImportImageSize,
  shouldNormalizeImportImageToPng,
  writeNormalizedWebpImportImage,
} from "./importImages";
import { unlinkIfExists } from "./storage";
import {
  MAX_IMPORT_IMAGE_BYTES,
  openZipArchiveReader,
  type ZipArchiveReader,
} from "./zipSafety";

export async function materializePageRecord(
  pageDraft: ImportPageDraft,
  pagesDir: string,
  index: number,
  zipReaderCache: Map<string, ZipArchiveReader>,
): Promise<LibraryPageRecord> {
  const pageId = randomUUID();
  const sourceExt = resolveImportSourceExt(pageDraft);
  const outputPath = resolveImportOutputPath(
    pagesDir,
    index,
    pageId,
    shouldNormalizeImportImageToPng(sourceExt) ? ".png" : sourceExt,
  );

  await writeImportedPageImage(
    pageDraft,
    pagesDir,
    pageId,
    sourceExt,
    outputPath,
    zipReaderCache,
  );

  const size = await readDecodedImportImageSize(outputPath, pageDraft.name);
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
  sourceExt: string,
  outputPath: string,
  zipReaderCache: Map<string, ZipArchiveReader>,
): Promise<void> {
  if (pageDraft.sourceKind === "zip-entry") {
    await writeZipImportedPageImage(
      pageDraft,
      pagesDir,
      pageId,
      sourceExt,
      outputPath,
      zipReaderCache,
    );
    return;
  }
  await writeFileImportedPageImage(pageDraft, sourceExt, outputPath);
}

async function writeZipImportedPageImage(
  pageDraft: ImportPageDraft,
  pagesDir: string,
  pageId: string,
  sourceExt: string,
  outputPath: string,
  zipReaderCache: Map<string, ZipArchiveReader>,
): Promise<void> {
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
  if (!shouldNormalizeImportImageToPng(sourceExt)) {
    await writeFile(outputPath, sourceBytes);
    return;
  }
  await writeNormalizedZipImportImage(
    pageDraft,
    pagesDir,
    pageId,
    sourceExt,
    outputPath,
    sourceBytes,
  );
}

async function writeNormalizedZipImportImage(
  pageDraft: ImportPageDraft,
  pagesDir: string,
  pageId: string,
  sourceExt: string,
  outputPath: string,
  sourceBytes: Buffer,
): Promise<void> {
  const tempSourcePath = join(pagesDir, `.${pageId}.import-source${sourceExt}`);
  try {
    await writeFile(tempSourcePath, sourceBytes);
    await writeNormalizedWebpImportImage(
      tempSourcePath,
      outputPath,
      pageDraft.name,
    );
  } finally {
    await unlinkIfExists(tempSourcePath);
  }
}

async function writeFileImportedPageImage(
  pageDraft: ImportPageDraft,
  sourceExt: string,
  outputPath: string,
): Promise<void> {
  await assertImportImageFileBudget(pageDraft.sourcePath);
  if (shouldNormalizeImportImageToPng(sourceExt)) {
    await writeNormalizedWebpImportImage(
      pageDraft.sourcePath,
      outputPath,
      pageDraft.name,
    );
    return;
  }
  await copyFile(pageDraft.sourcePath, outputPath);
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
