import { randomUUID } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import type {
  CreateImportFromPreviewRequest,
  CreateImportResult,
  ImportChapterDraft,
  ImportPageDraft,
  ImportPreviewResult,
  LibraryChapter,
  LibraryPageRecord
} from "../../shared/types";
import { resolveChapterStatus } from "./chapterRecords";
import {
  assertImportImageFileBudget,
  filterImportImageFiles,
  normalizeImportPageName,
  readDecodedImportImageSize,
  shouldNormalizeImportImageToPng,
  writeNormalizedWebpImportImage
} from "./importImages";
import { listImageEntriesInZip, listImageFiles, listNestedImageFolders, listZipFiles } from "./importSources";
import {
  DEFAULT_WORK_TITLE,
  WORKS_ROOT,
  collectUsedChapterTitles,
  createWork,
  ensureExistingWork,
  removeChapterDirectory,
  removeWorkFromIndexAndDisk,
  writeChapterFile,
  writeWorkFile
} from "./libraryFiles";
import { safeUnlink } from "./storage";
import { makeUniqueTitleInList, sanitizeTitle } from "./titles";
import { AdmZip, MAX_IMPORT_IMAGE_BYTES, readZipEntryData } from "./zipSafety";
import { hydrateChapter } from "./chapterSnapshots";

export async function previewImages(filePaths: string[]): Promise<ImportPreviewResult> {
  const normalized = await filterImportImageFiles(filePaths);
  const pages = normalized.map((filePath) => ({
    name: basename(filePath),
    sourceKind: "file" as const,
    sourcePath: filePath
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
        pages
      }
    ]
  };
}

export async function previewFolder(folderPath: string): Promise<ImportPreviewResult> {
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
          sourcePath: filePath
        }))
      }
    ]
  };
}

export async function previewZip(zipPath: string): Promise<ImportPreviewResult> {
  const pages = listImageEntriesInZip(zipPath).map((entry) => ({
    name: normalizeImportPageName(entry.entryName),
    sourceKind: "zip-entry" as const,
    sourcePath: zipPath,
    zipEntryName: entry.entryName
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
        pages
      }
    ]
  };
}

export async function previewZipFolder(folderPath: string): Promise<ImportPreviewResult> {
  const zipPaths = await listZipFiles(folderPath);
  const imageFolderPaths = await listNestedImageFolders(folderPath);
  const chapters = [
    ...zipPaths.map((zipPath) => ({
      sortKey: relative(folderPath, zipPath),
      chapter: {
        draftId: randomUUID(),
        title: basename(zipPath, extname(zipPath)),
        sourceKind: "zip-folder" as const,
        pages: listImageEntriesInZip(zipPath).map((entry) => ({
          name: normalizeImportPageName(entry.entryName),
          sourceKind: "zip-entry" as const,
          sourcePath: zipPath,
          zipEntryName: entry.entryName
        }))
      }
    })),
    ...(await Promise.all(
      imageFolderPaths.map(async (imageFolderPath) => ({
        sortKey: relative(folderPath, imageFolderPath),
        chapter: {
          draftId: randomUUID(),
          title: normalizeImportPageName(relative(folderPath, imageFolderPath)) || basename(imageFolderPath),
          sourceKind: "folder" as const,
          pages: (await listImageFiles(imageFolderPath)).map((filePath) => ({
            name: basename(filePath),
            sourceKind: "file" as const,
            sourcePath: filePath
          }))
        }
      }))
    ))
  ]
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey, undefined, { numeric: true, sensitivity: "base" }))
    .map(({ chapter }) => chapter);

  return {
    mode: "batch",
    sourceKind: "zip-folder",
    suggestedWorkTitle: basename(folderPath),
    chapters
  };
}

export async function createImportFromPreviewUnlocked(request: CreateImportFromPreviewRequest): Promise<CreateImportResult> {
  const selectedDraftIds = new Set(request.selections.filter((selection) => selection.enabled).map((selection) => selection.draftId));
  const selectedDrafts = request.preview.chapters.filter((draft) => selectedDraftIds.has(draft.draftId) && draft.pages.length > 0);
  if (selectedDrafts.length === 0) {
    throw new Error("생성할 화가 없습니다.");
  }

  const target =
    request.target.mode === "new" ? await createWork(request.target.title || request.preview.suggestedWorkTitle) : await ensureExistingWork(request.target.workId);
  const createdWorkId = request.target.mode === "new" ? target.id : null;
  const createdChapters: LibraryChapter[] = [];

  try {
    const selections = new Map(request.selections.map((selection) => [selection.draftId, selection]));
    const usedTitles = await collectUsedChapterTitles(target.id);

    for (const draft of request.preview.chapters) {
      const selection = selections.get(draft.draftId);
      if (!selection?.enabled) {
        continue;
      }

      const title = makeUniqueTitleInList(sanitizeTitle(selection.title || draft.title, "제목없음"), usedTitles);
      createdChapters.push(await materializeChapterFromDraft(target.id, draft, title));
    }

    if (createdChapters.length === 0) {
      throw new Error("생성할 화가 없습니다.");
    }

    const latestWork = await ensureExistingWork(target.id);
    latestWork.chapterOrder = [...latestWork.chapterOrder, ...createdChapters.map((chapter) => chapter.id)];
    latestWork.updatedAt = new Date().toISOString();
    await writeWorkFile(latestWork);

    return {
      workId: target.id,
      chapterIds: createdChapters.map((chapter) => chapter.id),
      openedChapter: hydrateChapter(createdChapters[0]!)
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

async function materializeChapterFromDraft(workId: string, draft: ImportChapterDraft, requestedTitle: string): Promise<LibraryChapter> {
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
      pages.push(await materializePageRecord(pageDraft, pagesDir, index));
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
      updatedAt: now
    };

    await writeChapterFile(chapter);
    return chapter;
  } catch (error) {
    await removeChapterDirectory(workId, chapterId);
    throw error;
  }
}

async function materializePageRecord(pageDraft: ImportPageDraft, pagesDir: string, index: number): Promise<LibraryPageRecord> {
  const pageId = randomUUID();
  const sourceExt =
    pageDraft.sourceKind === "zip-entry" ? extname(pageDraft.zipEntryName ?? "").toLowerCase() || ".png" : extname(pageDraft.sourcePath).toLowerCase() || ".png";
  const targetExt = shouldNormalizeImportImageToPng(sourceExt) ? ".png" : sourceExt;
  const outputPath = join(pagesDir, `${String(index + 1).padStart(3, "0")}-${pageId}${targetExt}`);

  if (pageDraft.sourceKind === "zip-entry") {
    const zip = new AdmZip(pageDraft.sourcePath);
    const entry = zip.getEntries().find((candidate) => candidate.entryName === pageDraft.zipEntryName);
    if (!entry) {
      throw new Error(`ZIP 항목을 찾지 못했습니다: ${pageDraft.zipEntryName ?? pageDraft.sourcePath}`);
    }
    const sourceBytes = readZipEntryData(entry, MAX_IMPORT_IMAGE_BYTES, pageDraft.zipEntryName ?? pageDraft.sourcePath);
    if (shouldNormalizeImportImageToPng(sourceExt)) {
      const tempSourcePath = join(pagesDir, `.${pageId}.import-source${sourceExt}`);
      try {
        await writeFile(tempSourcePath, sourceBytes);
        await writeNormalizedWebpImportImage(tempSourcePath, outputPath, pageDraft.name);
      } finally {
        await safeUnlink(tempSourcePath);
      }
    } else {
      await writeFile(outputPath, sourceBytes);
    }
  } else {
    await assertImportImageFileBudget(pageDraft.sourcePath);
    if (shouldNormalizeImportImageToPng(sourceExt)) {
      await writeNormalizedWebpImportImage(pageDraft.sourcePath, outputPath, pageDraft.name);
    } else {
      await copyFile(pageDraft.sourcePath, outputPath);
    }
  }

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
    updatedAt: now
  };
}
