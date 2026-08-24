/* eslint-disable max-lines -- import staging and publication sequencing stay co-located for transaction auditability */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { throwIfAborted } from "../abortSignal";
import type {
  CreateImportFromPreviewRequest,
  CreateImportResult,
  ImportChapterDraft,
  ImportPreviewResult,
} from "../../shared/importTypes";
import type {
  LibraryChapter,
  LibraryPageRecord,
} from "../../shared/libraryTypes";
import { tMain } from "./localization";
import { resolveChapterStatus } from "./chapterRecords";
import {
  filterImportImageFiles,
  normalizeImportPageName,
} from "./importImages";
import { materializePageRecord } from "./importPageMaterialize";
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
  const normalized = await filterImportImageFiles(filePaths);
  const pages = normalized.map((filePath) => ({
    name: basename(filePath),
    sourceKind: "file" as const,
    sourcePath: filePath,
  }));

  return {
    mode: "single",
    sourceKind: "images",
    suggestedWorkTitle: tMain("import.defaultWorkTitle"),
    chapters: [
      {
        draftId: randomUUID(),
        title: tMain("import.untitled"),
        sourceKind: "images",
        pages,
      },
    ],
  };
}

export async function previewFolder(
  folderPath: string,
): Promise<ImportPreviewResult> {
  const filePaths = await listImageFiles(folderPath);
  return {
    mode: "single",
    sourceKind: "folder",
    suggestedWorkTitle: tMain("import.defaultWorkTitle"),
    chapters: [
      {
        draftId: randomUUID(),
        title: basename(folderPath),
        sourceKind: "folder",
        pages: filePaths.map((filePath) => ({
          name: basename(filePath),
          sourceKind: "file" as const,
          sourcePath: filePath,
          sourceFileName: basename(filePath),
          sourceRelativePath: relative(folderPath, filePath),
        })),
      },
    ],
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
  const chapters = [
    ...zipChapters,
    ...(await Promise.all(
      imageFolderPaths.map(async (imageFolderPath) => ({
        sortKey: relative(folderPath, imageFolderPath),
        chapter: {
          draftId: randomUUID(),
          title:
            normalizeImportPageName(relative(folderPath, imageFolderPath)) ||
            basename(imageFolderPath),
          sourceKind: "folder" as const,
          pages: (await listImageFiles(imageFolderPath)).map((filePath) => ({
            name: basename(filePath),
            sourceKind: "file" as const,
            sourcePath: filePath,
            sourceFileName: basename(filePath),
            sourceRelativePath: relative(folderPath, filePath),
          })),
        },
      })),
    )),
  ]
    .sort((left, right) =>
      left.sortKey.localeCompare(right.sortKey, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    )
    .map(({ chapter }) => chapter);

  return {
    mode: "batch",
    sourceKind: "zip-folder",
    suggestedWorkTitle: basename(folderPath),
    chapters,
  };
}

export async function createImportFromPreviewUnlocked(
  request: CreateImportFromPreviewRequest,
  imageRuntime: ImportImageRuntime,
  signal?: AbortSignal,
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
  return runLibraryTransaction("import", async (transaction) => {
    throwIfAborted(signal);
    return request.target.mode === "new"
      ? importIntoNewWork(
          transaction,
          request,
          selectedDrafts,
          imageRuntime,
          signal,
        )
      : importIntoExistingWork(
          transaction,
          request.target.workId,
          request,
          selectedDrafts,
          imageRuntime,
          signal,
        );
  });
}

async function importIntoNewWork(
  transaction: LibraryTransaction,
  request: CreateImportFromPreviewRequest,
  selectedDrafts: ImportChapterDraft[],
  imageRuntime: ImportImageRuntime,
  signal?: AbortSignal,
): Promise<CreateImportResult> {
  if (request.target.mode !== "new") {
    throw new Error("새 작품 import target이 아닙니다.");
  }
  const target = createUnpublishedWork(
    request.target.title || request.preview.suggestedWorkTitle,
  );
  const index = await readIndexFile();
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

  const now = new Date().toISOString();
  const nextWork: WorkFile = {
    ...target,
    chapterOrder: createdChapters.map((chapter) => chapter.id),
    updatedAt: now,
  };
  await writeJsonFile(
    join(published.stagingDirectory, "work.json"),
    validateWorkFile(nextWork.id, nextWork),
  );
  await stageIndexFile(transaction, {
    workOrder: [...index.workOrder, target.id],
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

async function importIntoExistingWork(
  transaction: LibraryTransaction,
  workId: string,
  request: CreateImportFromPreviewRequest,
  selectedDrafts: ImportChapterDraft[],
  imageRuntime: ImportImageRuntime,
  signal?: AbortSignal,
): Promise<CreateImportResult> {
  const target = await ensureExistingWork(workId);
  const usedTitles = await collectUsedChapterTitles(workId);
  throwIfAborted(signal);
  const createdChapters = await materializeSelectedDrafts({
    workId,
    selectedDrafts,
    requestSelections: request.selections,
    imageRuntime,
    signal,
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

  const nextWork: WorkFile = {
    ...target,
    chapterOrder: [
      ...target.chapterOrder,
      ...createdChapters.map((chapter) => chapter.id),
    ],
    updatedAt: new Date().toISOString(),
  };
  await stageWorkFile(transaction, nextWork);
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
  usedTitles,
  prepareChapterDirectories,
}: {
  workId: string;
  selectedDrafts: ImportChapterDraft[];
  requestSelections: CreateImportFromPreviewRequest["selections"];
  imageRuntime: ImportImageRuntime;
  signal?: AbortSignal;
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
}: {
  workId: string;
  chapterId: string;
  draft: ImportChapterDraft;
  requestedTitle: string;
  directories: ChapterDirectoryTarget;
  zipReaderCache: Map<string, ZipArchiveReader>;
  imageRuntime: ImportImageRuntime;
  signal?: AbortSignal;
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
      ),
    );
  }

  const chapter: LibraryChapter = {
    id: chapterId,
    workId,
    title,
    sourceKind: draft.sourceKind,
    status: resolveChapterStatus(pages),
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: now,
    updatedAt: now,
  };
  throwIfAborted(signal);
  await writeJsonFile(
    join(directories.writeChapterDirectory, "chapter.json"),
    validateChapterFilePaths(workId, chapterId, chapter),
  );
  return chapter;
}
