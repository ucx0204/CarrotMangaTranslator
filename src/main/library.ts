import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { nativeImage } from "electron";
import type {
  ChapterSnapshot,
  CreateImportFromPreviewRequest,
  CreateImportResult,
  ImportChapterDraft,
  ImportPageDraft,
  ImportPreviewResult,
  ImportSourceKind,
  LibraryChapter,
  LibraryChapterSummary,
  LibraryIndex,
  LibraryPageRecord,
  LibraryWork,
  LibraryWorkSummary,
  MangaPage,
  WorkShareImportFromPackageRequest,
  WorkShareExportRequest,
  WorkShareExportResult,
  WorkShareImportEntry,
  WorkShareImportPreviewView,
  WorkShareImportResult
} from "../shared/types";
import { normalizeBlockType } from "../shared/geometry";
import { getAppPaths } from "./appPaths";
import { fileToDataUrl, isPathInside, isSupportedImagePath, readJsonFile, safeUnlink, sortNaturally, writeJsonFile } from "./libraryStore/storage";
import {
  AdmZip,
  MAX_IMPORT_IMAGE_BYTES,
  MAX_SHARE_IMAGE_BYTES,
  MAX_SHARE_JSON_BYTES,
  assertZipEntryBudget,
  assertZipEntrySize,
  buildSafeShareEntryMap,
  normalizeSharePathSegment,
  normalizeShareRelativePath,
  readZipEntryData,
  type ZipEntryLike
} from "./libraryStore/zipSafety";
export { pathExists } from "./libraryStore/storage";

const LIBRARY_ROOT = getAppPaths().libraryDir;
const INDEX_PATH = join(LIBRARY_ROOT, "index.json");
const WORKS_ROOT = join(LIBRARY_ROOT, "works");
const DEFAULT_WORK_TITLE = "미정 작품";
const SHARE_FORMAT = "manga-gemma-translator-share";
const SHARE_VERSION = 1;

type StoredIndexFile = {
  workOrder: string[];
};

type WorkFile = LibraryWork;

type ChapterFile = LibraryChapter;

type ShareManifest = {
  format: string;
  version: number;
  exportedAt: string;
  work: {
    id: string;
    title: string;
  };
  chapterOrder: string[];
};

type SharePackage = {
  entries: Map<string, ZipEntryLike>;
  manifest: ShareManifest;
  chapters: Array<{
    packageChapterId: string;
    chapter: ChapterFile;
  }>;
};

export type ChapterRunPaths = {
  chapterDir: string;
  runDir: string;
};

export function getLibraryRoot(): string {
  return LIBRARY_ROOT;
}

export async function listLibrary(): Promise<LibraryIndex> {
  const index = await readIndexFile();
  const works: LibraryWorkSummary[] = [];

  for (const workId of index.workOrder) {
    const work = await readWorkFile(workId);
    if (!work) {
      continue;
    }
    const chapters: LibraryChapterSummary[] = [];
    for (const chapterId of work.chapterOrder) {
      const chapter = await readChapterFile(workId, chapterId);
      if (!chapter) {
        continue;
      }
      chapters.push(toChapterSummary(chapter));
    }
    works.push({ ...work, chapters });
  }

  return {
    workOrder: works.map((work) => work.id),
    works
  };
}

export async function openChapter(chapterId: string): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("열려는 화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("열려는 화를 찾지 못했습니다.");
  }
  return hydrateChapter(chapter);
}

export async function readLibraryPageImageDataUrl(imagePath: string): Promise<string> {
  const resolvedImagePath = assertLibraryImagePath(imagePath);
  return fileToDataUrl(resolvedImagePath);
}

export function assertLibraryImagePath(imagePath: string): string {
  const resolvedRoot = resolve(LIBRARY_ROOT);
  const resolvedImagePath = resolve(imagePath);
  if (!isPathInside(resolvedRoot, resolvedImagePath)) {
    throw new Error("보관함 밖의 이미지는 열 수 없습니다.");
  }
  if (!isSupportedImagePath(resolvedImagePath)) {
    throw new Error("지원하지 않는 이미지 형식입니다.");
  }
  if (!existsSync(resolvedImagePath)) {
    throw new Error("페이지 이미지 파일을 찾지 못했습니다.");
  }
  return resolvedImagePath;
}

export async function saveChapterSnapshot(snapshot: ChapterSnapshot): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(snapshot.id);
  if (!locator || locator.workId !== snapshot.workId) {
    throw new Error("저장할 화의 보관함 위치가 올바르지 않습니다.");
  }
  const current = await readChapterFile(locator.workId, locator.chapterId);
  if (!current) {
    throw new Error("저장할 화를 찾지 못했습니다.");
  }
  validateChapterSnapshotForStorage(snapshot, current);
  const stored = toStoredChapter(snapshot, current);
  await writeChapterFile(stored);
  return hydrateChapter(stored);
}

export async function renameWork(workId: string, title: string): Promise<LibraryIndex> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  work.title = sanitizeTitle(title, DEFAULT_WORK_TITLE);
  work.updatedAt = new Date().toISOString();
  await writeWorkFile(work);
  return listLibrary();
}

export async function renameChapter(chapterId: string, title: string): Promise<LibraryIndex> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }
  chapter.title = await makeUniqueChapterTitle(locator.workId, sanitizeTitle(title, "제목없음"), chapter.id);
  chapter.updatedAt = new Date().toISOString();
  await writeChapterFile(chapter);
  await touchWork(locator.workId, chapter.updatedAt);
  return listLibrary();
}

export async function deleteWork(workId: string): Promise<LibraryIndex> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }

  const index = await readIndexFile();
  index.workOrder = index.workOrder.filter((id) => id !== workId);
  await writeIndexFile(index);

  const workDir = join(WORKS_ROOT, workId);
  if (existsSync(workDir)) {
    await rm(workDir, { recursive: true, force: true });
  }

  return listLibrary();
}

export async function deleteChapter(chapterId: string): Promise<LibraryIndex> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }

  const work = await readWorkFile(locator.workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }

  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }

  work.chapterOrder = work.chapterOrder.filter((id) => id !== chapter.id);
  work.updatedAt = new Date().toISOString();
  await writeWorkFile(work);

  const chapterDir = join(WORKS_ROOT, locator.workId, "chapters", locator.chapterId);
  if (existsSync(chapterDir)) {
    await rm(chapterDir, { recursive: true, force: true });
  }

  return listLibrary();
}

export async function reorderChapters(workId: string, chapterIds: string[]): Promise<LibraryIndex> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  work.chapterOrder = reorderIds(work.chapterOrder, chapterIds);
  work.updatedAt = new Date().toISOString();
  await writeWorkFile(work);
  return listLibrary();
}

export async function reorderPages(chapterId: string, pageIds: string[]): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }
  chapter.pageOrder = reorderIds(chapter.pageOrder, pageIds);
  chapter.pages = reorderRecords(chapter.pages, chapter.pageOrder);
  chapter.updatedAt = new Date().toISOString();
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, chapter.updatedAt);
  return hydrateChapter(chapter);
}

export async function deletePage(chapterId: string, pageId: string): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }

  const target = chapter.pages.find((page) => page.id === pageId);
  if (!target) {
    return hydrateChapter(chapter);
  }

  chapter.pageOrder = chapter.pageOrder.filter((id) => id !== pageId);
  chapter.pages = chapter.pages.filter((page) => page.id !== pageId);
  chapter.updatedAt = new Date().toISOString();
  chapter.status = resolveChapterStatus(chapter.pages);

  await writeChapterFile(chapter);
  await touchWork(locator.workId, chapter.updatedAt);

  await safeUnlink(target.imagePath);
  if (target.inpaintedImagePath) {
    await safeUnlink(target.inpaintedImagePath);
  }
  await removePageArtifacts(locator.workId, locator.chapterId, pageId);

  return hydrateChapter(chapter);
}

export async function previewImages(filePaths: string[]): Promise<ImportPreviewResult> {
  const normalized = sortNaturally(filePaths.filter((filePath) => isSupportedImagePath(filePath)));
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
  const entries = await readdir(folderPath, { withFileTypes: true });
  const zipPaths = sortNaturally(
    entries.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".zip").map((entry) => join(folderPath, entry.name))
  );
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

export async function createImport(request: CreateImportFromPreviewRequest): Promise<CreateImportResult> {
  const selectedDraftIds = new Set(request.selections.filter((selection) => selection.enabled).map((selection) => selection.draftId));
  const selectedDrafts = request.preview.chapters.filter((draft) => selectedDraftIds.has(draft.draftId) && draft.pages.length > 0);
  if (selectedDrafts.length === 0) {
    throw new Error("생성할 화가 없습니다.");
  }

  const target = request.target.mode === "new" ? await createWork(request.target.title || request.preview.suggestedWorkTitle) : await ensureExistingWork(request.target.workId);
  const selections = new Map(request.selections.map((selection) => [selection.draftId, selection]));
  const createdChapterIds: string[] = [];
  let openedChapter: ChapterSnapshot | undefined;

  for (const draft of request.preview.chapters) {
    const selection = selections.get(draft.draftId);
    if (!selection?.enabled) {
      continue;
    }

    const chapter = await createChapterFromDraft(target.id, draft, selection.title);
    createdChapterIds.push(chapter.id);
    if (!openedChapter) {
      openedChapter = await hydrateChapter(chapter);
    }
  }

  if (createdChapterIds.length === 0) {
    throw new Error("생성할 화가 없습니다.");
  }

  return {
    workId: target.id,
    chapterIds: createdChapterIds,
    openedChapter
  };
}

export async function exportWorkShareToFile(
  request: WorkShareExportRequest & { outputPath: string }
): Promise<WorkShareExportResult> {
  const work = await ensureExistingWork(request.workId);
  const requestedIds = new Set(request.chapterIds);
  const chapterIds = work.chapterOrder.filter((chapterId) => requestedIds.has(chapterId));
  if (chapterIds.length === 0) {
    throw new Error("공유할 화를 선택해 주세요.");
  }

  const zip = new AdmZip();
  const manifest: ShareManifest = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    exportedAt: new Date().toISOString(),
    work: {
      id: work.id,
      title: work.title
    },
    chapterOrder: chapterIds
  };

  zip.addFile("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));

  let pageCount = 0;
  for (const chapterId of chapterIds) {
    const chapter = await readChapterFile(work.id, chapterId);
    if (!chapter) {
      throw new Error("공유할 화를 찾지 못했습니다.");
    }

    const packagePages: LibraryPageRecord[] = [];
    const orderedPages = reorderRecords(chapter.pages, chapter.pageOrder);
    for (const [pageIndex, page] of orderedPages.entries()) {
      if (!existsSync(page.imagePath)) {
        throw new Error(`원본 이미지를 찾지 못했습니다: ${page.name}`);
      }
      const imageExt = extname(page.imagePath).toLowerCase() || ".png";
      if (!isSupportedImagePath(page.imagePath)) {
        throw new Error(`지원하지 않는 이미지 형식입니다: ${page.name}`);
      }
      const packageImagePath = `chapters/${chapter.id}/pages/${String(pageIndex + 1).padStart(3, "0")}-${page.id}${imageExt}`;
      zip.addFile(packageImagePath, await readFile(page.imagePath));
      packagePages.push({
        ...page,
        imagePath: packageImagePath,
        inpaintedImagePath: undefined
      });
      pageCount += 1;
    }

    const packageChapter: ChapterFile = {
      ...chapter,
      pageOrder: orderedPages.map((page) => page.id),
      pages: packagePages
    };
    zip.addFile(`chapters/${chapter.id}/chapter.json`, Buffer.from(`${JSON.stringify(packageChapter, null, 2)}\n`, "utf8"));
  }

  await mkdir(dirname(request.outputPath), { recursive: true });
  zip.writeZip(request.outputPath);

  return {
    filePath: request.outputPath,
    workTitle: work.title,
    chapterCount: chapterIds.length,
    pageCount
  };
}

export async function previewWorkShareImport(packagePath: string): Promise<WorkShareImportPreviewView> {
  const sharePackage = readSharePackage(packagePath);
  return {
    workTitle: sharePackage.manifest.work.title,
    chapters: sharePackage.chapters.map(({ packageChapterId, chapter }) => ({
      packageChapterId,
      title: chapter.title,
      pageCount: chapter.pages.length
    }))
  };
}

export async function importWorkShare(request: WorkShareImportFromPackageRequest): Promise<WorkShareImportResult> {
  const sharePackage = readSharePackage(request.packagePath);
  if (request.entries.length === 0) {
    throw new Error("가져올 화가 없습니다.");
  }

  if (request.target.mode === "new") {
    return importWorkShareAsNewWork(sharePackage, request);
  }

  return importWorkShareIntoExistingWork(sharePackage, request);
}

export async function markChapterPagesRunning(chapterId: string, pageIds: string[]): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }

  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((page) =>
    pageIds.includes(page.id)
      ? {
          ...page,
          analysisStatus: "running",
          lastError: undefined,
          updatedAt: now
        }
      : page
  );
  chapter.status = resolveChapterStatus(chapter.pages);
  chapter.updatedAt = now;
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
  return hydrateChapter(chapter);
}

export async function updatePageAfterAnalysis(chapterId: string, page: MangaPage, warnings: string[], status: "completed" | "failed"): Promise<void> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    return;
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    return;
  }

  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((record) =>
    record.id === page.id
      ? {
          ...record,
          blocks: page.blocks,
          analysisStatus: status,
          lastError: status === "failed" ? warnings[warnings.length - 1] : undefined,
          updatedAt: now
        }
      : record
  );
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
}

export async function finalizeRunningPages(
  chapterId: string,
  pageIds: string[],
  status: "idle" | "failed",
  errorMessage?: string
): Promise<void> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    return;
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    return;
  }

  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((page) =>
    pageIds.includes(page.id) && page.analysisStatus === "running"
      ? {
          ...page,
          analysisStatus: status,
          lastError: status === "failed" ? errorMessage : undefined,
          updatedAt: now
        }
      : page
  );
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
}

export async function updatePagesAfterAnalysis(chapterId: string, pages: MangaPage[]): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }

  const pageMap = new Map(pages.map((page) => [page.id, page]));
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((record) => {
    const next = pageMap.get(record.id);
    if (!next) {
      return record;
    }
    return {
      ...record,
      blocks: next.blocks,
      analysisStatus: next.analysisStatus,
      lastError: next.lastError,
      updatedAt: now
    };
  });
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
  return hydrateChapter(chapter);
}

export async function updatePagesAfterInpainting(chapterId: string, pages: MangaPage[]): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }

  const pageMap = new Map(pages.map((page) => [page.id, page]));
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((record) => {
    const next = pageMap.get(record.id);
    if (!next) {
      return record;
    }
    if (next.inpaintedImagePath) {
      assertChapterImagePath(locator.workId, locator.chapterId, next.inpaintedImagePath, "인페인팅 결과 이미지 경로가 올바르지 않습니다.");
    }
    return {
      ...record,
      inpaintedImagePath: next.inpaintedImagePath,
      updatedAt: now
    };
  });
  chapter.updatedAt = now;
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
  return hydrateChapter(chapter);
}

export async function setPageInpaintingResult(
  chapterId: string,
  pageId: string,
  inpaintedImagePath?: string | null
): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }
  if (!chapter.pages.some((page) => page.id === pageId)) {
    throw new Error("인페인팅 결과를 적용할 페이지를 찾지 못했습니다.");
  }

  const resolvedInpaintedPath = inpaintedImagePath
    ? assertChapterImagePath(locator.workId, locator.chapterId, inpaintedImagePath, "인페인팅 결과 이미지 경로가 올바르지 않습니다.")
    : undefined;
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((page) =>
    page.id === pageId
      ? {
          ...page,
          inpaintedImagePath: resolvedInpaintedPath,
          updatedAt: now
        }
      : page
  );
  chapter.updatedAt = now;
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
  return hydrateChapter(chapter);
}

export async function resolvePagesForRun(chapterId: string, runMode: "pending" | "all" | "single-page", pageId?: string): Promise<{
  chapter: ChapterSnapshot;
  pages: MangaPage[];
}> {
  const chapter = await openChapter(chapterId);
  const pages =
    runMode === "all"
      ? chapter.pages
      : runMode === "single-page"
        ? chapter.pages.filter((page) => page.id === pageId)
        : chapter.pages.filter((page) => page.analysisStatus !== "completed");

  return {
    chapter,
    pages
  };
}

export function getRunPaths(chapterId: string, runId: string): Promise<ChapterRunPaths> {
  return (async () => {
    const locator = await findChapterLocation(chapterId);
    if (!locator) {
      throw new Error("화를 찾지 못했습니다.");
    }
    const chapterDir = join(WORKS_ROOT, locator.workId, "chapters", locator.chapterId);
    const runDir = join(chapterDir, "runs", runId);
    return { chapterDir, runDir };
  })();
}

async function createWork(title: string): Promise<LibraryWork> {
  const now = new Date().toISOString();
  const work: LibraryWork = {
    id: randomUUID(),
    title: sanitizeTitle(title, DEFAULT_WORK_TITLE),
    chapterOrder: [],
    createdAt: now,
    updatedAt: now
  };
  const index = await readIndexFile();
  index.workOrder.push(work.id);
  await writeIndexFile(index);
  await writeWorkFile(work);
  return work;
}

async function ensureExistingWork(workId: string): Promise<LibraryWork> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("선택한 작품을 찾지 못했습니다.");
  }
  return work;
}

async function createChapterFromDraft(workId: string, draft: ImportChapterDraft, requestedTitle: string): Promise<LibraryChapter> {
  const work = await ensureExistingWork(workId);
  const now = new Date().toISOString();
  const chapterId = randomUUID();
  const title = await makeUniqueChapterTitle(workId, sanitizeTitle(requestedTitle || draft.title, "제목없음"));
  const chapterDir = join(WORKS_ROOT, workId, "chapters", chapterId);
  const pagesDir = join(chapterDir, "pages");
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

  work.chapterOrder = [...work.chapterOrder, chapterId];
  work.updatedAt = now;
  await writeWorkFile(work);
  await writeChapterFile(chapter);
  return chapter;
}

async function materializePageRecord(pageDraft: ImportPageDraft, pagesDir: string, index: number): Promise<LibraryPageRecord> {
  const pageId = randomUUID();
  const targetExt =
    pageDraft.sourceKind === "zip-entry" ? extname(pageDraft.zipEntryName ?? "").toLowerCase() || ".png" : extname(pageDraft.sourcePath).toLowerCase() || ".png";
  const outputPath = join(pagesDir, `${String(index + 1).padStart(3, "0")}-${pageId}${targetExt}`);

  if (pageDraft.sourceKind === "zip-entry") {
    const zip = new AdmZip(pageDraft.sourcePath);
    const entry = zip.getEntries().find((candidate) => candidate.entryName === pageDraft.zipEntryName);
    if (!entry) {
      throw new Error(`ZIP 항목을 찾지 못했습니다: ${pageDraft.zipEntryName ?? pageDraft.sourcePath}`);
    }
    await writeFile(outputPath, readZipEntryData(entry, MAX_IMPORT_IMAGE_BYTES, pageDraft.zipEntryName ?? pageDraft.sourcePath));
  } else {
    await copyFile(pageDraft.sourcePath, outputPath);
  }

  const image = nativeImage.createFromPath(outputPath);
  const size = image.getSize();
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

async function importWorkShareAsNewWork(sharePackage: SharePackage, request: WorkShareImportFromPackageRequest): Promise<WorkShareImportResult> {
  if (request.target.mode !== "new") {
    throw new Error("새 작품 가져오기 요청이 아닙니다.");
  }
  assertPackageOnlyEntries(request.entries);

  const work = await createWork(request.target.title || sharePackage.manifest.work.title);
  const chapterByPackageId = new Map(sharePackage.chapters.map((item) => [item.packageChapterId, item.chapter]));
  const usedTitles = new Set<string>();
  const chapterIds: string[] = [];

  for (const entry of request.entries) {
    const packageChapter = chapterByPackageId.get(entry.packageChapterId);
    if (!packageChapter) {
      throw new Error("공유 파일에서 가져올 화를 찾지 못했습니다.");
    }
    const title = makeUniqueTitleInList(sanitizeTitle(entry.title || packageChapter.title, "제목없음"), usedTitles);
    const chapter = await materializeSharedChapter({
      workId: work.id,
      packageChapter,
      entries: sharePackage.entries,
      requestedTitle: title
    });
    chapterIds.push(chapter.id);
  }

  if (chapterIds.length === 0) {
    throw new Error("가져올 화가 없습니다.");
  }

  work.chapterOrder = chapterIds;
  work.updatedAt = new Date().toISOString();
  await writeWorkFile(work);

  return {
    workId: work.id,
    chapterIds,
    openedChapter: await openChapter(chapterIds[0]!)
  };
}

async function importWorkShareIntoExistingWork(sharePackage: SharePackage, request: WorkShareImportFromPackageRequest): Promise<WorkShareImportResult> {
  if (request.target.mode !== "existing") {
    throw new Error("기존 작품 가져오기 요청이 아닙니다.");
  }

  const work = await ensureExistingWork(request.target.workId);
  const currentChapters = new Map<string, ChapterFile>();
  for (const chapterId of work.chapterOrder) {
    const chapter = await readChapterFile(work.id, chapterId);
    if (chapter) {
      currentChapters.set(chapterId, chapter);
    }
  }

  const chapterByPackageId = new Map(sharePackage.chapters.map((item) => [item.packageChapterId, item.chapter]));
  const usedTitles = new Set<string>();
  const usedExistingIds = new Set<string>();
  const usedPackageIds = new Set<string>();
  const finalChapterIds: string[] = [];
  const now = new Date().toISOString();

  for (const entry of request.entries) {
    if (entry.source === "existing") {
      if (usedExistingIds.has(entry.chapterId)) {
        throw new Error("같은 기존 화가 두 번 포함되어 있습니다.");
      }
      const chapter = currentChapters.get(entry.chapterId);
      if (!chapter) {
        throw new Error("기존 작품에서 적용할 화를 찾지 못했습니다.");
      }
      chapter.title = makeUniqueTitleInList(sanitizeTitle(entry.title || chapter.title, "제목없음"), usedTitles);
      chapter.updatedAt = now;
      await writeChapterFile(chapter);
      usedExistingIds.add(chapter.id);
      finalChapterIds.push(chapter.id);
      continue;
    }

    if (usedPackageIds.has(entry.packageChapterId)) {
      throw new Error("같은 공유 화가 두 번 포함되어 있습니다.");
    }
    const packageChapter = chapterByPackageId.get(entry.packageChapterId);
    if (!packageChapter) {
      throw new Error("공유 파일에서 가져올 화를 찾지 못했습니다.");
    }
    const title = makeUniqueTitleInList(sanitizeTitle(entry.title || packageChapter.title, "제목없음"), usedTitles);
    const chapter = await materializeSharedChapter({
      workId: work.id,
      packageChapter,
      entries: sharePackage.entries,
      requestedTitle: title
    });
    usedPackageIds.add(entry.packageChapterId);
    finalChapterIds.push(chapter.id);
  }

  if (finalChapterIds.length === 0) {
    throw new Error("적용할 화가 없습니다.");
  }

  for (const chapterId of work.chapterOrder) {
    if (finalChapterIds.includes(chapterId)) {
      continue;
    }
    const chapterDir = join(WORKS_ROOT, work.id, "chapters", chapterId);
    if (existsSync(chapterDir)) {
      await rm(chapterDir, { recursive: true, force: true });
    }
  }

  work.chapterOrder = finalChapterIds;
  work.updatedAt = now;
  await writeWorkFile(work);

  return {
    workId: work.id,
    chapterIds: finalChapterIds,
    openedChapter: await openChapter(finalChapterIds[0]!)
  };
}

async function materializeSharedChapter({
  workId,
  packageChapter,
  entries,
  requestedTitle
}: {
  workId: string;
  packageChapter: ChapterFile;
  entries: Map<string, ZipEntryLike>;
  requestedTitle: string;
}): Promise<ChapterFile> {
  const now = new Date().toISOString();
  const chapterId = randomUUID();
  const chapterDir = join(WORKS_ROOT, workId, "chapters", chapterId);
  const pagesDir = join(chapterDir, "pages");
  await mkdir(pagesDir, { recursive: true });

  const pages: LibraryPageRecord[] = [];
  for (const [index, packagePage] of reorderRecords(packageChapter.pages, packageChapter.pageOrder).entries()) {
    const packageImagePath = normalizeShareRelativePath(packagePage.imagePath, "페이지 이미지 경로가 올바르지 않습니다.");
    const entry = entries.get(packageImagePath);
    if (!entry) {
      throw new Error(`공유 파일에 이미지가 없습니다: ${packagePage.name}`);
    }

    const pageId = randomUUID();
    const targetExt = extname(packageImagePath).toLowerCase() || ".png";
    if (!isSupportedImagePath(packageImagePath)) {
      throw new Error(`지원하지 않는 이미지 형식입니다: ${packagePage.name}`);
    }
    const outputPath = join(pagesDir, `${String(index + 1).padStart(3, "0")}-${pageId}${targetExt}`);
    await writeFile(outputPath, readZipEntryData(entry, MAX_SHARE_IMAGE_BYTES, packageImagePath));

    const image = nativeImage.createFromPath(outputPath);
    const size = image.getSize();
    pages.push({
      ...packagePage,
      id: pageId,
      imagePath: outputPath,
      inpaintedImagePath: undefined,
      width: size.width || packagePage.width || 1000,
      height: size.height || packagePage.height || 1400,
      blocks: packagePage.blocks.map((block, blockIndex) => ({
        ...block,
        id: `${pageId}-block-${blockIndex + 1}`
      })),
      createdAt: now,
      updatedAt: now
    });
  }

  const chapter: ChapterFile = {
    ...packageChapter,
    id: chapterId,
    workId,
    title: requestedTitle,
    status: resolveChapterStatus(pages),
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: now,
    updatedAt: now
  };
  await writeChapterFile(chapter);
  return chapter;
}

async function hydrateChapter(chapter: ChapterFile): Promise<ChapterSnapshot> {
  const pages = reorderRecords(chapter.pages, chapter.pageOrder).map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => ({
      ...block,
      type: normalizeBlockType(block.type)
    })),
    dataUrl: ""
  }));

  return {
    ...chapter,
    pageOrder: pages.map((page) => page.id),
    pages
  };
}

function toStoredChapter(snapshot: ChapterSnapshot, current?: ChapterFile): ChapterFile {
  const currentPages = new Map(current?.pages.map((page) => [page.id, page]) ?? []);
  return {
    ...snapshot,
    workId: current?.workId ?? snapshot.workId,
    sourceKind: current?.sourceKind ?? snapshot.sourceKind,
    createdAt: current?.createdAt ?? snapshot.createdAt,
    pages: snapshot.pages.map(({ dataUrl: _dataUrl, ...page }) => {
      const currentPage = currentPages.get(page.id);
      return {
        ...page,
        imagePath: currentPage?.imagePath ?? page.imagePath,
        inpaintedImagePath: currentPage?.inpaintedImagePath ?? page.inpaintedImagePath,
        createdAt: currentPage?.createdAt ?? page.createdAt
      };
    })
  };
}

function validateChapterSnapshotForStorage(snapshot: ChapterSnapshot, current: ChapterFile): void {
  const currentPageIds = new Set(current.pages.map((page) => page.id));
  const pageIds = new Set<string>();
  for (const page of snapshot.pages) {
    if (!currentPageIds.has(page.id)) {
      throw new Error("저장할 수 없는 페이지가 포함되어 있습니다.");
    }
    if (pageIds.has(page.id)) {
      throw new Error("중복된 페이지 ID가 있습니다.");
    }
    pageIds.add(page.id);
    assertLibraryImagePath(page.imagePath);
    if (page.inpaintedImagePath) {
      assertLibraryImagePath(page.inpaintedImagePath);
    }
  }

  if (pageIds.size !== snapshot.pageOrder.length) {
    throw new Error("페이지 순서 정보가 페이지 목록과 맞지 않습니다.");
  }
  for (const pageId of snapshot.pageOrder) {
    if (!pageIds.has(pageId)) {
      throw new Error("페이지 순서 정보가 페이지 목록과 맞지 않습니다.");
    }
  }
}

function assertChapterImagePath(workId: string, chapterId: string, imagePath: string, message: string): string {
  const resolvedImagePath = assertLibraryImagePath(imagePath);
  const chapterDir = resolve(join(WORKS_ROOT, workId, "chapters", chapterId));
  if (!isPathInside(chapterDir, resolvedImagePath)) {
    throw new Error(message);
  }
  return resolvedImagePath;
}

async function readIndexFile(): Promise<StoredIndexFile> {
  await ensureLibraryStructure();
  if (!existsSync(INDEX_PATH)) {
    return { workOrder: [] };
  }
  return readJsonFile<StoredIndexFile>(INDEX_PATH, { workOrder: [] });
}

async function writeIndexFile(index: StoredIndexFile): Promise<void> {
  await ensureLibraryStructure();
  await writeJsonFile(INDEX_PATH, index);
}

async function readWorkFile(workId: string): Promise<WorkFile | null> {
  const path = workFilePath(workId);
  if (!existsSync(path)) {
    return null;
  }
  return readJsonFile<WorkFile>(path);
}

async function writeWorkFile(work: WorkFile): Promise<void> {
  await mkdir(dirname(workFilePath(work.id)), { recursive: true });
  await writeJsonFile(workFilePath(work.id), work);
}

async function touchWork(workId: string, updatedAt: string): Promise<void> {
  const work = await readWorkFile(workId);
  if (!work) {
    return;
  }
  work.updatedAt = updatedAt;
  await writeWorkFile(work);
}

async function readChapterFile(workId: string, chapterId: string): Promise<ChapterFile | null> {
  const path = chapterFilePath(workId, chapterId);
  if (!existsSync(path)) {
    return null;
  }
  return readJsonFile<ChapterFile>(path);
}

async function writeChapterFile(chapter: ChapterFile): Promise<void> {
  await mkdir(dirname(chapterFilePath(chapter.workId, chapter.id)), { recursive: true });
  await writeJsonFile(chapterFilePath(chapter.workId, chapter.id), chapter);
}

async function findChapterLocation(chapterId: string): Promise<{ workId: string; chapterId: string } | null> {
  const index = await readIndexFile();
  for (const workId of index.workOrder) {
    const work = await readWorkFile(workId);
    if (!work) {
      continue;
    }
    if (work.chapterOrder.includes(chapterId)) {
      return { workId, chapterId };
    }
  }
  return null;
}

async function ensureLibraryStructure(): Promise<void> {
  await mkdir(WORKS_ROOT, { recursive: true });
}

async function makeUniqueChapterTitle(workId: string, desired: string, excludeChapterId?: string): Promise<string> {
  const work = await ensureExistingWork(workId);
  const used = new Set<string>();
  for (const chapterId of work.chapterOrder) {
    if (chapterId === excludeChapterId) {
      continue;
    }
    const chapter = await readChapterFile(workId, chapterId);
    if (chapter) {
      used.add(chapter.title);
    }
  }

  if (!used.has(desired)) {
    return desired;
  }

  let index = 1;
  while (used.has(`${desired} (${index})`)) {
    index += 1;
  }
  return `${desired} (${index})`;
}

function sanitizeTitle(title: string, fallback: string): string {
  const trimmed = title.trim();
  return trimmed || fallback;
}

async function listImageFiles(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  return sortNaturally(
    entries.filter((entry) => entry.isFile() && isSupportedImagePath(entry.name)).map((entry) => join(folderPath, entry.name))
  );
}

async function listNestedImageFolders(rootPath: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    const childDirectories = sortNaturally(entries.filter((entry) => entry.isDirectory()).map((entry) => join(currentPath, entry.name)));

    if (currentPath !== rootPath && entries.some((entry) => entry.isFile() && isSupportedImagePath(entry.name))) {
      found.push(currentPath);
    }

    for (const childPath of childDirectories) {
      await walk(childPath);
    }
  }

  await walk(rootPath);
  return found;
}

function listImageEntriesInZip(zipPath: string): ZipEntryLike[] {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  assertZipEntryBudget(entries, "ZIP 파일");
  return entries
    .filter((entry) => !entry.isDirectory && isSupportedImagePath(entry.entryName))
    .sort((left, right) => left.entryName.localeCompare(right.entryName, undefined, { numeric: true, sensitivity: "base" }));
}

function readSharePackage(packagePath: string): SharePackage {
  const zip = new AdmZip(packagePath);
  const entries = buildSafeShareEntryMap(zip.getEntries());
  const manifest = readRequiredShareJson<ShareManifest>(entries, "manifest.json");
  validateShareManifest(manifest);

  const chapters = manifest.chapterOrder.map((packageChapterId) => {
    const safeChapterId = normalizeSharePathSegment(packageChapterId, "공유 파일의 화 ID가 올바르지 않습니다.");
    const chapter = readRequiredShareJson<ChapterFile>(entries, `chapters/${safeChapterId}/chapter.json`);
    validateShareChapter(chapter, safeChapterId, entries);
    return {
      packageChapterId: safeChapterId,
      chapter
    };
  });

  return {
    entries,
    manifest: {
      ...manifest,
      chapterOrder: chapters.map((chapter) => chapter.packageChapterId)
    },
    chapters
  };
}

function readRequiredShareJson<T>(entries: Map<string, ZipEntryLike>, path: string): T {
  const entry = entries.get(path);
  if (!entry) {
    throw new Error(`공유 파일에 필요한 정보가 없습니다: ${path}`);
  }
  try {
    return JSON.parse(readZipEntryData(entry, MAX_SHARE_JSON_BYTES, path).toString("utf8")) as T;
  } catch {
    throw new Error(`공유 파일의 JSON을 읽지 못했습니다: ${path}`);
  }
}

function validateShareManifest(manifest: ShareManifest): void {
  if (manifest.format !== SHARE_FORMAT || manifest.version !== SHARE_VERSION) {
    throw new Error("지원하지 않는 공유 파일 버전입니다.");
  }
  if (!manifest.work || typeof manifest.work.title !== "string") {
    throw new Error("공유 파일의 작품 정보가 올바르지 않습니다.");
  }
  if (!Array.isArray(manifest.chapterOrder) || manifest.chapterOrder.length === 0) {
    throw new Error("공유 파일에 화 정보가 없습니다.");
  }
}

function validateShareChapter(chapter: ChapterFile, packageChapterId: string, entries: Map<string, ZipEntryLike>): void {
  if (chapter.id !== packageChapterId || !Array.isArray(chapter.pages) || !Array.isArray(chapter.pageOrder)) {
    throw new Error("공유 파일의 화 정보가 올바르지 않습니다.");
  }
  const pageIds = new Set(chapter.pages.map((page) => page.id));
  for (const pageId of chapter.pageOrder) {
    if (!pageIds.has(pageId)) {
      throw new Error("공유 파일의 페이지 순서가 올바르지 않습니다.");
    }
  }
  for (const page of chapter.pages) {
    const imagePath = normalizeShareRelativePath(page.imagePath, "공유 파일의 이미지 경로가 올바르지 않습니다.");
    if (!imagePath.startsWith(`chapters/${packageChapterId}/pages/`)) {
      throw new Error("공유 파일의 이미지 위치가 올바르지 않습니다.");
    }
    if (!isSupportedImagePath(imagePath)) {
      throw new Error(`지원하지 않는 이미지 형식입니다: ${page.name}`);
    }
    const imageEntry = entries.get(imagePath);
    if (!imageEntry) {
      throw new Error(`공유 파일에 이미지가 없습니다: ${page.name}`);
    }
    assertZipEntrySize(imageEntry, MAX_SHARE_IMAGE_BYTES, imagePath);
  }
}

function assertPackageOnlyEntries(entries: WorkShareImportEntry[]): asserts entries is Array<Extract<WorkShareImportEntry, { source: "package" }>> {
  if (entries.some((entry) => entry.source !== "package")) {
    throw new Error("새 작품으로 가져올 때는 공유 파일의 화만 선택할 수 있습니다.");
  }
}

function makeUniqueTitleInList(desired: string, used: Set<string>): string {
  if (!used.has(desired)) {
    used.add(desired);
    return desired;
  }

  let index = 1;
  while (used.has(`${desired} (${index})`)) {
    index += 1;
  }
  const next = `${desired} (${index})`;
  used.add(next);
  return next;
}

function normalizeImportPageName(entryName: string): string {
  return entryName.replace(/\\/g, "/");
}

function workFilePath(workId: string): string {
  return join(WORKS_ROOT, workId, "work.json");
}

function chapterFilePath(workId: string, chapterId: string): string {
  return join(WORKS_ROOT, workId, "chapters", chapterId, "chapter.json");
}

function reorderIds(currentOrder: string[], nextOrder: string[]): string[] {
  const currentSet = new Set(currentOrder);
  const filtered = nextOrder.filter((id) => currentSet.has(id));
  const remainder = currentOrder.filter((id) => !filtered.includes(id));
  return [...filtered, ...remainder];
}

function reorderRecords<T extends { id: string }>(records: T[], order: string[]): T[] {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const ordered: T[] = [];
  for (const id of order) {
    const record = recordMap.get(id);
    if (record) {
      ordered.push(record);
      recordMap.delete(id);
    }
  }
  return [...ordered, ...recordMap.values()];
}

function resolveChapterStatus(pages: Array<Pick<LibraryPageRecord, "analysisStatus">>): LibraryChapter["status"] {
  if (pages.length === 0) {
    return "idle";
  }
  const statuses = pages.map((page) => page.analysisStatus);
  if (statuses.every((status) => status === "completed")) {
    return "completed";
  }
  if (statuses.some((status) => status === "running")) {
    return "running";
  }
  if (statuses.every((status) => status === "failed")) {
    return "failed";
  }
  return statuses.some((status) => status === "completed") ? "partial" : "idle";
}

function toChapterSummary(chapter: LibraryChapter): LibraryChapterSummary {
  return {
    id: chapter.id,
    workId: chapter.workId,
    title: chapter.title,
    status: chapter.status,
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
    pageCount: chapter.pages.length
  };
}

async function removePageArtifacts(workId: string, chapterId: string, pageId: string): Promise<void> {
  const runsRoot = join(WORKS_ROOT, workId, "chapters", chapterId, "runs");
  if (!existsSync(runsRoot)) {
    return;
  }

  const runs = await readdir(runsRoot, { withFileTypes: true });
  for (const run of runs) {
    if (!run.isDirectory()) {
      continue;
    }
    const target = join(runsRoot, run.name, "pages", pageId);
    if (!existsSync(target)) {
      continue;
    }
    await rm(target, { recursive: true, force: true });
  }
}

export async function cleanupLegacyLogs(): Promise<void> {
  const logsRoot = resolve(getAppPaths().logsDir);
  const targets = [
    join(logsRoot, "app-jobs"),
    join(logsRoot, "bench"),
    join(logsRoot, "debug"),
    join(logsRoot, "runtime")
  ];

  for (const target of targets) {
    if (!existsSync(target)) {
      continue;
    }
    const resolved = resolve(target);
    if (!resolved.startsWith(logsRoot)) {
      continue;
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

export async function resetAppLog(logPath: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, "", "utf8");
}
