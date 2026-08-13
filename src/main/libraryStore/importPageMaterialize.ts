import { randomUUID } from "node:crypto";
import { copyFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ImportPageDraft } from "../../shared/importTypes";
import type { LibraryPageRecord } from "../../shared/libraryTypes";
import { throwIfAborted } from "../abortSignal";
import {
  probeImageBuffer,
  probeImageFile,
  type ImageHeaderMetadata,
} from "./imageHeaderProbe";
import type { ImportImageRuntime } from "./importImageRuntime";
import {
  assertImportImageFileBudget,
  convertValidatedWebpImportImage,
  validateStoredImportImage,
} from "./importImages";
import { tMain } from "./localization";
import { unlinkIfExists } from "./storage";
import {
  MAX_IMPORT_IMAGE_BYTES,
  openZipArchiveReader,
  type ZipArchiveReader,
} from "./zipSafety";

export type ImportPageMaterializationTarget = {
  writePagesDirectory: string;
  publishedPagesDirectory: string;
};

type PreparedImportPageImage =
  | {
      kind: "file";
      sourceExt: string;
      metadata: ImageHeaderMetadata;
    }
  | {
      kind: "zip-entry";
      sourceExt: string;
      metadata: ImageHeaderMetadata;
      sourceBytes: Buffer;
    };

export async function materializePageRecord(
  pageDraft: ImportPageDraft,
  target: ImportPageMaterializationTarget | string,
  index: number,
  zipReaderCache: Map<string, ZipArchiveReader>,
  imageRuntime: ImportImageRuntime,
  signal?: AbortSignal,
): Promise<LibraryPageRecord> {
  const pageId = randomUUID();
  const resolvedTarget: ImportPageMaterializationTarget =
    typeof target === "string"
      ? {
          writePagesDirectory: target,
          publishedPagesDirectory: target,
        }
      : target;
  throwIfAborted(signal);
  const preparedImage = await prepareImportedPageImage(
    pageDraft,
    zipReaderCache,
    signal,
  );
  throwIfAborted(signal);
  const targetExt = resolveImportOutputExt(
    preparedImage.sourceExt,
    preparedImage.metadata.format,
  );
  const outputPath = resolveImportOutputPath(
    resolvedTarget.writePagesDirectory,
    index,
    pageId,
    targetExt,
    pageDraft.storageStem,
  );
  const publishedPath = resolveImportOutputPath(
    resolvedTarget.publishedPagesDirectory,
    index,
    pageId,
    targetExt,
    pageDraft.storageStem,
  );

  try {
    const finalMetadata = await writeImportedPageImage(
      pageDraft,
      resolvedTarget.writePagesDirectory,
      pageId,
      preparedImage,
      outputPath,
      imageRuntime,
      signal,
    );
    throwIfAborted(signal);
    const now = new Date().toISOString();
    return {
      id: pageId,
      name: pageDraft.name,
      imagePath: publishedPath,
      width: finalMetadata.width,
      height: finalMetadata.height,
      blocks: [],
      analysisStatus: "idle",
      createdAt: now,
      updatedAt: now,
    };
  } catch (error) {
    await unlinkIfExists(outputPath);
    throw error;
  }
}

async function writeImportedPageImage(
  pageDraft: ImportPageDraft,
  pagesDir: string,
  pageId: string,
  preparedImage: PreparedImportPageImage,
  outputPath: string,
  imageRuntime: ImportImageRuntime,
  signal?: AbortSignal,
): Promise<ImageHeaderMetadata> {
  throwIfAborted(signal);
  if (preparedImage.kind === "zip-entry") {
    return writeZipImportedPageImage(
      pageDraft,
      pagesDir,
      pageId,
      preparedImage,
      outputPath,
      imageRuntime,
      signal,
    );
  }
  return writeFileImportedPageImage(
    pageDraft,
    preparedImage,
    outputPath,
    imageRuntime,
    signal,
  );
}

async function writeZipImportedPageImage(
  pageDraft: ImportPageDraft,
  pagesDir: string,
  pageId: string,
  preparedImage: Extract<PreparedImportPageImage, { kind: "zip-entry" }>,
  outputPath: string,
  imageRuntime: ImportImageRuntime,
  signal?: AbortSignal,
): Promise<ImageHeaderMetadata> {
  throwIfAborted(signal);
  if (preparedImage.metadata.format !== "webp") {
    await writeFile(outputPath, preparedImage.sourceBytes, { signal });
    throwIfAborted(signal);
    return validateStoredImportImage({
      imagePath: outputPath,
      expected: preparedImage.metadata,
      label: pageDraft.name,
      runtime: imageRuntime,
      signal,
    });
  }
  return writeNormalizedZipImportImage(
    pageDraft,
    pagesDir,
    pageId,
    outputPath,
    preparedImage,
    imageRuntime,
    signal,
  );
}

async function writeNormalizedZipImportImage(
  pageDraft: ImportPageDraft,
  pagesDir: string,
  pageId: string,
  outputPath: string,
  preparedImage: Extract<PreparedImportPageImage, { kind: "zip-entry" }>,
  imageRuntime: ImportImageRuntime,
  signal?: AbortSignal,
): Promise<ImageHeaderMetadata> {
  const tempSourcePath = join(pagesDir, `.${pageId}.import-source.webp`);
  try {
    throwIfAborted(signal);
    await writeFile(tempSourcePath, preparedImage.sourceBytes, { signal });
    throwIfAborted(signal);
    return await convertValidatedWebpImportImage({
      sourcePath: tempSourcePath,
      outputPath,
      sourceMetadata: preparedImage.metadata,
      label: pageDraft.name,
      runtime: imageRuntime,
      signal,
    });
  } finally {
    await unlinkIfExists(tempSourcePath);
  }
}

async function writeFileImportedPageImage(
  pageDraft: ImportPageDraft,
  preparedImage: Extract<PreparedImportPageImage, { kind: "file" }>,
  outputPath: string,
  imageRuntime: ImportImageRuntime,
  signal?: AbortSignal,
): Promise<ImageHeaderMetadata> {
  throwIfAborted(signal);
  if (preparedImage.metadata.format === "webp") {
    return convertValidatedWebpImportImage({
      sourcePath: pageDraft.sourcePath,
      outputPath,
      sourceMetadata: preparedImage.metadata,
      label: pageDraft.name,
      runtime: imageRuntime,
      signal,
    });
  }
  await copyFile(pageDraft.sourcePath, outputPath);
  throwIfAborted(signal);
  return validateStoredImportImage({
    imagePath: outputPath,
    expected: preparedImage.metadata,
    label: pageDraft.name,
    runtime: imageRuntime,
    signal,
  });
}

async function prepareImportedPageImage(
  pageDraft: ImportPageDraft,
  zipReaderCache: Map<string, ZipArchiveReader>,
  signal?: AbortSignal,
): Promise<PreparedImportPageImage> {
  throwIfAborted(signal);
  const sourceExt = resolveImportSourceExt(pageDraft);
  if (pageDraft.sourceKind !== "zip-entry") {
    await assertImportImageFileBudget(pageDraft.sourcePath);
    throwIfAborted(signal);
    const metadata = await probeImageFile(
      pageDraft.sourcePath,
      pageDraft.name,
      undefined,
      signal,
    );
    throwIfAborted(signal);
    return {
      kind: "file",
      sourceExt,
      metadata,
    };
  }

  const reader = await getCachedZipReader(
    pageDraft.sourcePath,
    zipReaderCache,
    signal,
  );
  throwIfAborted(signal);
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
  throwIfAborted(signal);
  const metadata = probeImageBuffer(sourceBytes, pageDraft.name);
  return {
    kind: "zip-entry",
    sourceExt,
    metadata,
    sourceBytes,
  };
}

function resolveImportOutputExt(
  sourceExt: string,
  format: ImageHeaderMetadata["format"],
): string {
  if (format === "webp" || format === "png") {
    return ".png";
  }
  return sourceExt === ".jpeg" ? ".jpeg" : ".jpg";
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
  storageStem?: string,
): string {
  if (storageStem !== undefined) {
    if (
      !/^[1-9]\d{0,5}$/.test(storageStem) ||
      storageStem !== String(index + 1)
    ) {
      throw new Error("웹 가져오기 이미지 번호가 올바르지 않습니다.");
    }
    return join(pagesDir, `${storageStem}${targetExt}`);
  }
  return join(
    pagesDir,
    `${String(index + 1).padStart(3, "0")}-${pageId}${targetExt}`,
  );
}

async function getCachedZipReader(
  zipPath: string,
  cache: Map<string, ZipArchiveReader>,
  signal?: AbortSignal,
): Promise<ZipArchiveReader> {
  throwIfAborted(signal);
  const cached = cache.get(zipPath);
  if (cached) {
    return cached;
  }
  const reader = await openZipArchiveReader(zipPath, tMain("import.zipFile"));
  // Register first so the caller's existing finally block owns close(), even
  // when cancellation happened while the archive was opening.
  cache.set(zipPath, reader);
  throwIfAborted(signal);
  return reader;
}
