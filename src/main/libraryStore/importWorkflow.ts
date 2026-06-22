import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import type {
  CreateImportFromPreviewRequest,
  CreateImportResult,
  ImportChapterDraft,
  ImportPreviewResult,
  LibraryChapter,
  LibraryPageRecord,
} from "../../shared/types";
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
  DEFAULT_WORK_TITLE,
  WORKS_ROOT,
  collectUsedChapterTitles,
  createWork,
  ensureExistingWork,
  removeChapterDirectory,
  removeWorkFromIndexAndDisk,
  writeChapterFile,
  writeWorkFile,
} from "./libraryFiles";
import { makeUniqueTitleInList, sanitizeTitle } from "./titles";
import type { ZipArchiveReader } from "./zipSafety";
import { hydrateChapter } from "./chapterSnapshots";

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
    suggestedWorkTitle: DEFAULT_WORK_TITLE,
    chapters: [
      {
        draftId: randomUUID(),
        title: "제목없음",
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
    suggestedWorkTitle: DEFAULT_WORK_TITLE,
    chapters: [
      {
        draftId: randomUUID(),
        title: basename(folderPath),
        sourceKind: "folder",
        pages: filePaths.map((filePath) => ({
          name: basename(filePath),
          sourceKind: "file" as const,
          sourcePath: filePath,
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
    suggestedWorkTitle: DEFAULT_WORK_TITLE,
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
    throw new Error("생성할 화가 없습니다.");
  }

  const target =
    request.target.mode === "new"
      ? await createWork(
          request.target.title || request.preview.suggestedWorkTitle,
        )
      : await ensureExistingWork(request.target.workId);
  const createdWorkId = request.target.mode === "new" ? target.id : null;
  const createdChapters: LibraryChapter[] = [];

  try {
    await materializeSelectedDrafts(
      target.id,
      selectedDrafts,
      request.selections,
      createdChapters,
    );
    if (createdChapters.length === 0) {
      throw new Error("생성할 화가 없습니다.");
    }

    const latestWork = await ensureExistingWork(target.id);
    latestWork.chapterOrder = [
      ...latestWork.chapterOrder,
      ...createdChapters.map((chapter) => chapter.id),
    ];
    latestWork.updatedAt = new Date().toISOString();
    await writeWorkFile(latestWork);

    const openedChapter = createdChapters[0];
    if (!openedChapter) {
      throw new Error("생성한 화를 열지 못했습니다.");
    }

    return {
      workId: target.id,
      chapterIds: createdChapters.map((chapter) => chapter.id),
      openedChapter: hydrateChapter(openedChapter),
    };
  } catch (error) {
    for (const chapter of createdChapters) {
      await removeChapterDirectory(chapter.workId, chapter.id);
    }
    if (createdWorkId) {
      await removeWorkFromIndexAndDisk(createdWorkId);
    }
    throw error;
  }
}

async function materializeSelectedDrafts(
  workId: string,
  selectedDrafts: ImportChapterDraft[],
  requestSelections: CreateImportFromPreviewRequest["selections"],
  createdChapters: LibraryChapter[],
): Promise<void> {
  const selections = new Map(
    requestSelections.map((selection) => [selection.draftId, selection]),
  );
  const usedTitles = await collectUsedChapterTitles(workId);
  const zipReaderCache = new Map<string, ZipArchiveReader>();

  try {
    for (const draft of selectedDrafts) {
      const selection = selections.get(draft.draftId);
      if (!selection) {
        continue;
      }
      const title = makeUniqueTitleInList(
        sanitizeTitle(selection.title || draft.title, "제목없음"),
        usedTitles,
      );
      usedTitles.add(title);
      createdChapters.push(
        await materializeChapterFromDraft(workId, draft, title, zipReaderCache),
      );
    }
  } finally {
    for (const reader of zipReaderCache.values()) {
      reader.close();
    }
  }
}

async function materializeChapterFromDraft(
  workId: string,
  draft: ImportChapterDraft,
  requestedTitle: string,
  zipReaderCache: Map<string, ZipArchiveReader>,
): Promise<LibraryChapter> {
  await ensureExistingWork(workId);
  const now = new Date().toISOString();
  const chapterId = randomUUID();
  const title = sanitizeTitle(requestedTitle || draft.title, "제목없음");
  const chapterDir = join(WORKS_ROOT, workId, "chapters", chapterId);
  const pagesDir = join(chapterDir, "pages");

  try {
    await mkdir(pagesDir, { recursive: true });

    const pages: LibraryPageRecord[] = [];
    for (const [index, pageDraft] of draft.pages.entries()) {
      pages.push(
        await materializePageRecord(pageDraft, pagesDir, index, zipReaderCache),
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

    await writeChapterFile(chapter);
    return chapter;
  } catch (error) {
    await removeChapterDirectory(workId, chapterId);
    throw error;
  }
}
