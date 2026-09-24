/* eslint-disable max-lines -- import staging and publication sequencing stay co-located for transaction auditability */
import { randomUUID } from "node:crypto";
import { ImportSourceIdentitySchema } from "../../shared/importSourceIdentity";
import { mkdir } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { throwIfAborted } from "../abortSignal";
import type {
  CreateImportFromPreviewRequest,
  CreateImportResult,
  ImportChapterDraft,
  ImportPreviewExcludedPage,
  ImportPreviewResult,
} from "../../shared/importTypes";
import type {
  LibraryChapter,
  LibraryPageRecord,
} from "../../shared/libraryTypes";
import { tMain } from "./localization";
import { resolveChapterStatus } from "./chapterRecords";
import {
  inspectImportImageFiles,
  normalizeImportPageName,
} from "./importImages";
import { materializePageRecord } from "./importPageMaterialize";
import type {
  NativeImportPageObservation,
  NativeImportPageObserver,
  NativeImportMetadataObserver,
} from "./importPublicationEvidence";
import {
  observeNativeImportedChapter,
  observeNativeImportedGuide,
  observeNativeImportedWork,
  nativeImportedWorkObserver,
} from "./importPublicationMetadata";
import {
  listImageEntriesInZip,
  listImageFiles,
  listNestedImageFolders,
  listZipFiles,
} from "./importSources";
import {
  collectUsedChapterTitles,
  createUnpublishedWork,
  ensureExistingWork,
  readIndexFile,
  validateChapterFilePaths,
  validateWorkFile,
  type WorkFile,
} from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import {
  runLibraryTransaction,
  type LibraryTransaction,
} from "./libraryTransaction";
import { stageIndexFile, stageWorkFile } from "./libraryTransactionFiles";
import { writeJsonFile } from "./storage";
import { makeUniqueTitleInList, sanitizeTitle } from "./titles";
import type { ZipArchiveReader } from "./zipSafety";
import { hydrateChapter } from "./chapterSnapshots";
import type { ImportImageRuntime } from "./importImageRuntime";

export async function previewImages(
  filePaths: string[],
): Promise<ImportPreviewResult> {
  const title = tMain("import.untitled");
  const inspected = await inspectImportImageFiles(filePaths);
  assertUsableInspectedImages(inspected);
  const pages = inspected.filePaths.map((filePath) => ({
    name: basename(filePath),
    sourceKind: "file" as const,
    sourcePath: filePath,
  }));
  return {
    mode: "single",
    sourceKind: "images",
    suggestedWorkTitle: tMain("import.defaultWorkTitle"),
    chapters: [{ draftId: randomUUID(), title, sourceKind: "images", pages }],
    ...excludedPreviewPages(title, inspected.excludedFilePaths),
  };
}
export async function previewFolder(
  folderPath: string,
): Promise<ImportPreviewResult> {
  const title = basename(folderPath);
  const inspected = await inspectImportImageFiles(
    await listImageFiles(folderPath),
  );
  assertUsableInspectedImages(inspected);
  return {
    mode: "single",
    sourceKind: "folder",
    suggestedWorkTitle: tMain("import.defaultWorkTitle"),
    chapters: [
      {
        draftId: randomUUID(),
        title,
        sourceKind: "folder",
        pages: inspected.filePaths.map((filePath) => ({
          name: basename(filePath),
          sourceKind: "file" as const,
          sourcePath: filePath,
          sourceFileName: basename(filePath),
          sourceRelativePath: relative(folderPath, filePath),
        })),
      },
    ],
    ...excludedPreviewPages(title, inspected.excludedFilePaths),
  };
}
export async function previewZip(
  zipPath: string,
): Promise<ImportPreviewResult> {
  const pages = (await listImageEntriesInZip(zipPath)).map((entry) => ({
    name: normalizeImportPageName(entry.entryName),
    sourceKind: "zip-entry" as const,
    sourcePath: zipPath,
    zipEntryName: entry.entryName,
  }));
  return {
    mode: "single",
    sourceKind: "zip",
    suggestedWorkTitle: tMain("import.defaultWorkTitle"),
    chapters: [
      {
        draftId: randomUUID(),
        title: basename(zipPath, extname(zipPath)),
        sourceKind: "zip",
        pages,
      },
    ],
  };
}
export async function previewZipFolder(
  folderPath: string,
): Promise<ImportPreviewResult> {
  const zipPaths = await listZipFiles(folderPath);
  const imageFolderPaths = await listNestedImageFolders(folderPath);
  const zipChapters = await Promise.all(
    zipPaths.map(async (zipPath) => ({
      sortKey: relative(folderPath, zipPath),
      chapter: {
        draftId: randomUUID(),
        title: basename(zipPath, extname(zipPath)),
        sourceKind: "zip-folder" as const,
        pages: (await listImageEntriesInZip(zipPath)).map((entry) => ({
          name: normalizeImportPageName(entry.entryName),
          sourceKind: "zip-entry" as const,
          sourcePath: zipPath,
          zipEntryName: entry.entryName,
        })),
      },
    })),
  );
  const imageFolderChapters = await Promise.all(
    imageFolderPaths.map(async (imageFolderPath) => {
      const title =
        normalizeImportPageName(relative(folderPath, imageFolderPath)) ||
        basename(imageFolderPath);
      const inspected = await inspectImportImageFiles(
        await listImageFiles(imageFolderPath),
      );
      return {
        sortKey: relative(folderPath, imageFolderPath),
        chapter: {
          draftId: randomUUID(),
          title,
          sourceKind: "folder" as const,
          pages: inspected.filePaths.map((filePath) => ({
            name: basename(filePath),
            sourceKind: "file" as const,
            sourcePath: filePath,
            sourceFileName: basename(filePath),
            sourceRelativePath: relative(folderPath, filePath),
          })),
        },
        excludedPages: buildExcludedPreviewPages(
          title,
          inspected.excludedFilePaths,
        ),
      };
    }),
  );
  const chapters = [...zipChapters, ...imageFolderChapters]
    .filter(({ chapter }) => chapter.pages.length > 0)
    .sort((left, right) =>
      left.sortKey.localeCompare(right.sortKey, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    )
    .map(({ chapter }) => chapter);
  const excludedPages = imageFolderChapters.flatMap(
    (item) => item.excludedPages,
  );
  assertBatchPreviewUsable(chapters, excludedPages);
  return {
    mode: "batch",
    sourceKind: "zip-folder",
    suggestedWorkTitle: basename(folderPath),
    chapters,
    ...(excludedPages.length > 0 ? { excludedPages } : {}),
  };
}
function assertBatchPreviewUsable(
  chapters: ImportChapterDraft[],
  excludedPages: ImportPreviewExcludedPage[],
): void {
  const firstExcluded = excludedPages[0];
  if (chapters.length === 0 && firstExcluded) {
    throw new Error(
      tMain("import.errors.invalidImageHeader", {
        file: `${firstExcluded.chapterTitle} / ${firstExcluded.pageName}`,
      }),
    );
  }
}
function excludedPreviewPages(
  chapterTitle: string,
  filePaths: string[],
): Pick<ImportPreviewResult, "excludedPages"> {
  const excludedPages = buildExcludedPreviewPages(chapterTitle, filePaths);
  return excludedPages.length > 0 ? { excludedPages } : {};
}
function buildExcludedPreviewPages(
  chapterTitle: string,
  filePaths: string[],
): ImportPreviewExcludedPage[] {
  return filePaths.map((filePath) => ({
    chapterTitle,
    pageName: basename(filePath),
    reason: "invalid-image-header" as const,
  }));
}
function assertUsableInspectedImages(
  inspection: Awaited<ReturnType<typeof inspectImportImageFiles>>,
): void {
  const firstExcluded = inspection.excludedFilePaths[0];
  if (inspection.filePaths.length === 0 && firstExcluded) {
    throw new Error(
      tMain("import.errors.invalidImageHeader", {
        file: basename(firstExcluded),
      }),
    );
  }
}

export async function createImportFromPreviewUnlocked(
  request: CreateImportFromPreviewRequest,
  imageRuntime: ImportImageRuntime,
  signal?: AbortSignal,
  publish?: Parameters<typeof runLibraryTransaction>[2],
  publication?: {
    assertCanCommit: () => void;
    observePage?: NativeImportPageObserver;
    observeMetadata?: NativeImportMetadataObserver;
    stage: (
      transaction: LibraryTransaction,
      result: CreateImportResult,
    ) => Promise<void>;
  },
): Promise<CreateImportResult> {
  const selectedDraftIds = new Set(
    request.selections
      .filter((selection) => selection.enabled)
      .map((selection) => selection.draftId),
  );
  const selectedDrafts = request.preview.chapters.filter(
    (draft) => selectedDraftIds.has(draft.draftId) && draft.pages.length > 0,
  );
  if (selectedDrafts.length === 0) {
    throw new Error(tMain("import.errors.noChapterToCreate"));
  }
  throwIfAborted(signal);
  publication?.assertCanCommit();
  return runLibraryTransaction(
    "import",
    async (transaction) => {
      throwIfAborted(signal);
      const result =
        request.target.mode === "new"
          ? await importIntoNewWork(
              transaction,
              request,
              selectedDrafts,
              imageRuntime,
              signal,
              publication?.observePage,
              publication?.observeMetadata,
            )
          : await importIntoExistingWork(
              transaction,
              request.target.workId,
              request,
              selectedDrafts,
              imageRuntime,
              signal,
              publication?.observePage,
              publication?.observeMetadata,
            );
      // Native composition only: receipt staging joins the same locked publication.
      // No public import payload accepts callbacks, paths or serialized receipts.
      if (publication)
        transaction.beforePublish(() => publication.stage(transaction, result));
      return result;
    },
    publish,
    publication?.assertCanCommit,
  );
}
async function importIntoNewWork(
  transaction: LibraryTransaction,
  request: CreateImportFromPreviewRequest,
  selectedDrafts: ImportChapterDraft[],
  imageRuntime: ImportImageRuntime,
  signal?: AbortSignal,
  observePage?: NativeImportPageObserver,
  observeMetadata?: NativeImportMetadataObserver,
): Promise<CreateImportResult> {
  if (request.target.mode !== "new") {
    throw new Error("새 작품 import target이 아닙니다.");
  }
  const target = createUnpublishedWork(
    request.target.title || request.preview.suggestedWorkTitle,
  );
  const finalWorkDirectory = join(getWorksRoot(), target.id);
  const published =
    await transaction.createPublishedDirectory(finalWorkDirectory);
  throwIfAborted(signal);
  const createdChapters = await materializeSelectedDrafts({
    workId: target.id,
    selectedDrafts,
    requestSelections: request.selections,
    imageRuntime,
    signal,
    observePage,
    observeMetadata,
    usedTitles: new Set<string>(),
    prepareChapterDirectories: async (chapterId) => {
      const writeChapterDirectory = join(
        published.stagingDirectory,
        "chapters",
        chapterId,
      );
      const publishedChapterDirectory = join(
        published.finalDirectory,
        "chapters",
        chapterId,
      );
      await mkdir(writeChapterDirectory, { recursive: true });
      return { writeChapterDirectory, publishedChapterDirectory };
    },
  });
  if (createdChapters.length === 0) {
    throw new Error(tMain("import.errors.noChapterToCreate"));
  }
  await writeImportedWorkMetadata(
    target,
    createdChapters,
    published.stagingDirectory,
    observeMetadata,
    signal,
  );
  transaction.beforePublish(async () => {
    throwIfAborted(signal);
    const index = await readIndexFile();
    await stageIndexFile(transaction, {
      workOrder: [...index.workOrder, target.id],
    });
  });
  throwIfAborted(signal);
  const openedChapter = createdChapters[0];
  if (!openedChapter) {
    throw new Error(tMain("import.errors.createdChapterOpen"));
  }
  return {
    workId: target.id,
    chapterIds: createdChapters.map((chapter) => chapter.id),
    openedChapter: hydrateChapter(openedChapter),
  };
}

async function writeImportedWorkMetadata(
  target: WorkFile,
  chapters: LibraryChapter[],
  directory: string,
  observeMetadata?: NativeImportMetadataObserver,
  signal?: AbortSignal,
) {
  const now = new Date().toISOString();
  const nextWork: WorkFile = {
    ...target,
    chapterOrder: chapters.map((chapter) => chapter.id),
    updatedAt: now,
  };
  await writeJsonFile(
    join(directory, "work.json"),
    validateWorkFile(nextWork.id, nextWork),
  );
  if (observeMetadata) {
    await observeNativeImportedWork({
      workId: target.id,
      directory,
      observe: observeMetadata,
      signal,
    });
    await observeNativeImportedGuide({
      workId: target.id,
      directory,
      observe: observeMetadata,
      signal,
    });
  }
}

async function importIntoExistingWork(
  transaction: LibraryTransaction,
  workId: string,
  request: CreateImportFromPreviewRequest,
  selectedDrafts: ImportChapterDraft[],
  imageRuntime: ImportImageRuntime,
  signal?: AbortSignal,
  observePage?: NativeImportPageObserver,
  observeMetadata?: NativeImportMetadataObserver,
): Promise<CreateImportResult> {
  await ensureExistingWork(workId);
  const usedTitles = await collectUsedChapterTitles(workId);
  throwIfAborted(signal);
  const createdChapters = await materializeSelectedDrafts({
    workId,
    selectedDrafts,
    requestSelections: request.selections,
    imageRuntime,
    signal,
    observePage,
    observeMetadata,
    usedTitles,
    prepareChapterDirectories: async (chapterId) => {
      const finalDirectory = join(
        getWorksRoot(),
        workId,
        "chapters",
        chapterId,
      );
      const published =
        await transaction.createPublishedDirectory(finalDirectory);
      return {
        writeChapterDirectory: published.stagingDirectory,
        publishedChapterDirectory: published.finalDirectory,
      };
    },
  });
  if (createdChapters.length === 0) {
    throw new Error(tMain("import.errors.noChapterToCreate"));
  }
  transaction.beforePublish(async () => {
    throwIfAborted(signal);
    const target = await ensureExistingWork(workId);
    await stageWorkFile(
      transaction,
      {
        ...target,
        chapterOrder: [
          ...target.chapterOrder,
          ...createdChapters.map((chapter) => chapter.id),
        ],
        updatedAt: new Date().toISOString(),
      },
      nativeImportedWorkObserver(workId, observeMetadata, signal),
    );
    if (observeMetadata)
      await observeNativeImportedGuide({
        workId,
        directory: join(getWorksRoot(), workId),
        observe: observeMetadata,
        signal,
      });
  });
  throwIfAborted(signal);
  const openedChapter = createdChapters[0];
  if (!openedChapter) {
    throw new Error(tMain("import.errors.createdChapterOpen"));
  }
  return {
    workId,
    chapterIds: createdChapters.map((chapter) => chapter.id),
    openedChapter: hydrateChapter(openedChapter),
  };
}
type ChapterDirectoryTarget = {
  writeChapterDirectory: string;
  publishedChapterDirectory: string;
};
async function materializeSelectedDrafts({
  workId,
  selectedDrafts,
  requestSelections,
  imageRuntime,
  signal,
  observePage,
  observeMetadata,
  usedTitles,
  prepareChapterDirectories,
}: {
  workId: string;
  selectedDrafts: ImportChapterDraft[];
  requestSelections: CreateImportFromPreviewRequest["selections"];
  imageRuntime: ImportImageRuntime;
  signal?: AbortSignal;
  observePage?: NativeImportPageObserver;
  observeMetadata?: NativeImportMetadataObserver;
  usedTitles: Set<string>;
  prepareChapterDirectories: (
    chapterId: string,
  ) => Promise<ChapterDirectoryTarget>;
}): Promise<LibraryChapter[]> {
  const selections = new Map(
    requestSelections.map((selection) => [selection.draftId, selection]),
  );
  const zipReaderCache = new Map<string, ZipArchiveReader>();
  const createdChapters: LibraryChapter[] = [];
  try {
    for (const draft of selectedDrafts) {
      throwIfAborted(signal);
      const selection = selections.get(draft.draftId);
      if (!selection) {
        continue;
      }
      const title = makeUniqueTitleInList(
        sanitizeTitle(selection.title || draft.title, tMain("import.untitled")),
        usedTitles,
      );
      usedTitles.add(title);
      const chapterId = randomUUID();
      const directories = await prepareChapterDirectories(chapterId);
      createdChapters.push(
        await materializeChapterFromDraft({
          workId,
          chapterId,
          draft,
          requestedTitle: title,
          directories,
          zipReaderCache,
          imageRuntime,
          signal,
          observation: observePage
            ? {
                observe: observePage,
                kind: "image",
                workId,
                chapterId,
                sourceChapterId: draft.draftId,
              }
            : undefined,
          observeMetadata,
        }),
      );
    }
    return createdChapters;
  } finally {
    for (const reader of zipReaderCache.values()) {
      reader.close();
    }
  }
}
async function materializeChapterFromDraft({
  workId,
  chapterId,
  draft,
  requestedTitle,
  directories,
  zipReaderCache,
  imageRuntime,
  signal,
  observation,
  observeMetadata,
}: {
  workId: string;
  chapterId: string;
  draft: ImportChapterDraft;
  requestedTitle: string;
  directories: ChapterDirectoryTarget;
  zipReaderCache: Map<string, ZipArchiveReader>;
  imageRuntime: ImportImageRuntime;
  signal?: AbortSignal;
  observation?: NativeImportPageObservation;
  observeMetadata?: NativeImportMetadataObserver;
}): Promise<LibraryChapter> {
  throwIfAborted(signal);
  const now = new Date().toISOString();
  const title = sanitizeTitle(
    requestedTitle || draft.title,
    tMain("import.untitled"),
  );
  const writePagesDirectory = join(directories.writeChapterDirectory, "pages");
  const publishedPagesDirectory = join(
    directories.publishedChapterDirectory,
    "pages",
  );
  await mkdir(writePagesDirectory, { recursive: true });
  const pages: LibraryPageRecord[] = [];
  for (const [index, pageDraft] of draft.pages.entries()) {
    throwIfAborted(signal);
    pages.push(
      await materializePageRecord(
        pageDraft,
        { writePagesDirectory, publishedPagesDirectory },
        index,
        zipReaderCache,
        imageRuntime,
        signal,
        observation,
      ),
    );
  }
  if (draft.importSource && draft.importSource.pageCount !== pages.length)
    throw new Error(
      "Import source identity does not match the selected page count.",
    );
  const chapter: LibraryChapter = {
    id: chapterId,
    workId,
    title,
    sourceKind: draft.sourceKind,
    ...(draft.importSource
      ? { importSource: ImportSourceIdentitySchema.parse(draft.importSource) }
      : {}),
    status: resolveChapterStatus(pages),
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: now,
    updatedAt: now,
  };
  await writeImportedChapterMetadata(
    chapter,
    directories.writeChapterDirectory,
    observeMetadata,
    signal,
  );
  return chapter;
}

async function writeImportedChapterMetadata(
  chapter: LibraryChapter,
  directory: string,
  observeMetadata?: NativeImportMetadataObserver,
  signal?: AbortSignal,
) {
  const { workId, id: chapterId } = chapter;
  throwIfAborted(signal);
  await writeJsonFile(
    join(directory, "chapter.json"),
    validateChapterFilePaths(workId, chapterId, chapter),
  );
  if (observeMetadata)
    await observeNativeImportedChapter({
      workId,
      chapterId,
      directory,
      observe: observeMetadata,
      signal,
    });
}
