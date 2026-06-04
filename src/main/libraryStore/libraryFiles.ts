import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { LibraryChapter, LibraryWork } from "../../shared/types";
import { getAppPaths } from "../appPaths";
import { isPathInside, isSupportedImagePath, readJsonFile, writeJsonFile } from "./storage";
import { makeUniqueTitleInList, sanitizeTitle } from "./titles";

export const LIBRARY_ROOT = getAppPaths().libraryDir;
export const INDEX_PATH = join(LIBRARY_ROOT, "index.json");
export const WORKS_ROOT = join(LIBRARY_ROOT, "works");
export const DEFAULT_WORK_TITLE = "미정 작품";

export type StoredIndexFile = {
  workOrder: string[];
};

export type WorkFile = LibraryWork;
export type ChapterFile = LibraryChapter;

export type ChapterRunPaths = {
  chapterDir: string;
  runDir: string;
};

export type LibraryCleanupResult = {
  missingWorkReferencesRemoved: number;
  missingChapterReferencesRemoved: number;
  workDirsRemoved: number;
  chapterDirsRemoved: number;
};

export function getLibraryRoot(): string {
  return LIBRARY_ROOT;
}

export function assertLibraryImagePath(imagePath: string): string {
  const resolvedImagePath = assertLibraryImagePathScope(imagePath);
  if (!existsSync(resolvedImagePath)) {
    throw new Error("페이지 이미지 파일을 찾지 못했습니다.");
  }
  return resolvedImagePath;
}

export function assertLibraryImagePathScope(imagePath: string, message = "보관함 밖의 이미지는 열 수 없습니다."): string {
  if (typeof imagePath !== "string" || imagePath.length === 0) {
    throw new Error(message);
  }
  const resolvedRoot = resolve(LIBRARY_ROOT);
  const resolvedImagePath = resolve(imagePath);
  if (!isPathInside(resolvedRoot, resolvedImagePath)) {
    throw new Error(message);
  }
  if (!isSupportedImagePath(resolvedImagePath)) {
    throw new Error("지원하지 않는 이미지 형식입니다.");
  }
  return resolvedImagePath;
}

export function assertChapterImagePath(workId: string, chapterId: string, imagePath: string, message: string): string {
  const resolvedImagePath = assertChapterImagePathScope(workId, chapterId, imagePath, message);
  if (!existsSync(resolvedImagePath)) {
    throw new Error("페이지 이미지 파일을 찾지 못했습니다.");
  }
  return resolvedImagePath;
}

export function assertChapterImagePathScope(workId: string, chapterId: string, imagePath: string, message: string): string {
  const resolvedImagePath = assertLibraryImagePathScope(imagePath, message);
  const chapterDir = resolve(join(WORKS_ROOT, workId, "chapters", chapterId));
  if (!isPathInside(chapterDir, resolvedImagePath)) {
    throw new Error(message);
  }
  return resolvedImagePath;
}

export async function readIndexFile(): Promise<StoredIndexFile> {
  await ensureLibraryStructure();
  return readJsonFile<StoredIndexFile>(INDEX_PATH, { workOrder: [] });
}

export async function writeIndexFile(index: StoredIndexFile): Promise<void> {
  await ensureLibraryStructure();
  await writeJsonFile(INDEX_PATH, index);
}

export async function readWorkFile(workId: string): Promise<WorkFile | null> {
  return readJsonFile<WorkFile | null>(workFilePath(workId), null);
}

export async function writeWorkFile(work: WorkFile): Promise<void> {
  await mkdir(dirname(workFilePath(work.id)), { recursive: true });
  await writeJsonFile(workFilePath(work.id), work);
}

export async function touchWork(workId: string, updatedAt: string): Promise<void> {
  const work = await readWorkFile(workId);
  if (!work) {
    return;
  }
  work.updatedAt = updatedAt;
  await writeWorkFile(work);
}

export async function readChapterFile(workId: string, chapterId: string): Promise<ChapterFile | null> {
  const chapter = await readJsonFile<ChapterFile | null>(chapterFilePath(workId, chapterId), null);
  return chapter ? validateChapterFilePaths(workId, chapterId, chapter) : null;
}

export async function writeChapterFile(chapter: ChapterFile): Promise<void> {
  const checkedChapter = validateChapterFilePaths(chapter.workId, chapter.id, chapter);
  await mkdir(dirname(chapterFilePath(checkedChapter.workId, checkedChapter.id)), { recursive: true });
  await writeJsonFile(chapterFilePath(checkedChapter.workId, checkedChapter.id), checkedChapter);
}

export async function findChapterLocation(chapterId: string): Promise<{ workId: string; chapterId: string } | null> {
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

export async function ensureLibraryStructure(): Promise<void> {
  await mkdir(WORKS_ROOT, { recursive: true });
}

export async function createWork(title: string): Promise<LibraryWork> {
  const now = new Date().toISOString();
  const work: LibraryWork = {
    id: randomUUID(),
    title: sanitizeTitle(title, DEFAULT_WORK_TITLE),
    chapterOrder: [],
    createdAt: now,
    updatedAt: now
  };
  const index = await readIndexFile();
  await writeWorkFile(work);
  try {
    await writeIndexFile({ workOrder: [...index.workOrder, work.id] });
  } catch (error) {
    await removeWorkDirectory(work.id);
    throw error;
  }
  return work;
}

export async function ensureExistingWork(workId: string): Promise<LibraryWork> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("선택한 작품을 찾지 못했습니다.");
  }
  return work;
}

export async function collectUsedChapterTitles(workId: string, excludeChapterId?: string): Promise<Set<string>> {
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
  return used;
}

export async function makeUniqueChapterTitle(workId: string, desired: string, excludeChapterId?: string): Promise<string> {
  const used = await collectUsedChapterTitles(workId, excludeChapterId);
  return makeUniqueTitleInList(desired, used);
}

export async function removeWorkFromIndexAndDisk(workId: string): Promise<void> {
  const index = await readIndexFile();
  if (index.workOrder.includes(workId)) {
    await writeIndexFile({ workOrder: index.workOrder.filter((id) => id !== workId) });
  }
  await removeWorkDirectory(workId);
}

export async function removeWorkDirectory(workId: string): Promise<void> {
  const worksRoot = resolve(WORKS_ROOT);
  const workDir = resolve(join(WORKS_ROOT, workId));
  if (!isPathInside(worksRoot, workDir) || workDir === worksRoot) {
    return;
  }
  if (existsSync(workDir)) {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function removeChapterDirectory(workId: string, chapterId: string): Promise<void> {
  const chaptersRoot = resolve(join(WORKS_ROOT, workId, "chapters"));
  const chapterDir = resolve(join(chaptersRoot, chapterId));
  if (!isPathInside(chaptersRoot, chapterDir) || chapterDir === chaptersRoot) {
    return;
  }
  if (existsSync(chapterDir)) {
    await rm(chapterDir, { recursive: true, force: true });
  }
}

export function workFilePath(workId: string): string {
  return join(WORKS_ROOT, workId, "work.json");
}

export function chapterFilePath(workId: string, chapterId: string): string {
  return join(WORKS_ROOT, workId, "chapters", chapterId, "chapter.json");
}

export async function removePageArtifacts(workId: string, chapterId: string, pageId: string): Promise<void> {
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

export async function cleanupLibraryOrphansUnlocked(): Promise<LibraryCleanupResult> {
  await ensureLibraryStructure();
  const result: LibraryCleanupResult = {
    missingWorkReferencesRemoved: 0,
    missingChapterReferencesRemoved: 0,
    workDirsRemoved: 0,
    chapterDirsRemoved: 0
  };

  const index = await readIndexFile();
  const retainedWorkIds: string[] = [];
  for (const workId of index.workOrder) {
    const work = await readWorkFile(workId);
    if (!work) {
      result.missingWorkReferencesRemoved += 1;
      continue;
    }
    retainedWorkIds.push(workId);
  }
  if (retainedWorkIds.length !== index.workOrder.length) {
    await writeIndexFile({ workOrder: retainedWorkIds });
  }

  const retainedWorkIdSet = new Set(retainedWorkIds);
  const workEntries = await readdir(WORKS_ROOT, { withFileTypes: true });
  for (const entry of workEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (retainedWorkIdSet.has(entry.name)) {
      continue;
    }
    await removeWorkDirectory(entry.name);
    result.workDirsRemoved += 1;
  }

  for (const workId of retainedWorkIds) {
    const work = await readWorkFile(workId);
    if (!work) {
      continue;
    }

    const retainedChapterIds: string[] = [];
    for (const chapterId of work.chapterOrder) {
      const chapter = await readChapterFile(workId, chapterId);
      if (!chapter) {
        result.missingChapterReferencesRemoved += 1;
        continue;
      }
      retainedChapterIds.push(chapterId);
    }
    if (retainedChapterIds.length !== work.chapterOrder.length) {
      await writeWorkFile({
        ...work,
        chapterOrder: retainedChapterIds,
        updatedAt: new Date().toISOString()
      });
    }

    const chaptersRoot = join(WORKS_ROOT, workId, "chapters");
    if (!existsSync(chaptersRoot)) {
      continue;
    }
    const retainedChapterIdSet = new Set(retainedChapterIds);
    const chapterEntries = await readdir(chaptersRoot, { withFileTypes: true });
    for (const entry of chapterEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (retainedChapterIdSet.has(entry.name)) {
        continue;
      }
      await removeChapterDirectory(workId, entry.name);
      result.chapterDirsRemoved += 1;
    }
  }

  return result;
}

function validateChapterFilePaths(workId: string, chapterId: string, chapter: ChapterFile): ChapterFile {
  assertChapterStorageLocation(workId, chapterId);
  if (chapter.workId !== workId || chapter.id !== chapterId) {
    throw new Error("화 정보의 보관함 위치가 올바르지 않습니다.");
  }
  if (!Array.isArray(chapter.pages) || !Array.isArray(chapter.pageOrder)) {
    throw new Error("화 정보가 올바르지 않습니다.");
  }

  const pageIds = new Set<string>();
  const pages = chapter.pages.map((page) => {
    if (!page || typeof page.id !== "string") {
      throw new Error("화 정보가 올바르지 않습니다.");
    }
    if (pageIds.has(page.id)) {
      throw new Error("중복된 페이지 ID가 있습니다.");
    }
    pageIds.add(page.id);

    return {
      ...page,
      imagePath: assertChapterImagePathScope(workId, chapterId, page.imagePath, "페이지 이미지 경로가 올바르지 않습니다."),
      inpaintedImagePath: page.inpaintedImagePath
        ? assertChapterImagePathScope(workId, chapterId, page.inpaintedImagePath, "인페인팅 결과 이미지 경로가 올바르지 않습니다.")
        : undefined
    };
  });

  for (const pageId of chapter.pageOrder) {
    if (!pageIds.has(pageId)) {
      throw new Error("페이지 순서 정보가 페이지 목록과 맞지 않습니다.");
    }
  }

  return {
    ...chapter,
    pages
  };
}

function assertChapterStorageLocation(workId: string, chapterId: string): void {
  if (!isSafeStoreId(workId) || !isSafeStoreId(chapterId)) {
    throw new Error("화 정보의 보관함 위치가 올바르지 않습니다.");
  }
  const worksRoot = resolve(WORKS_ROOT);
  const chaptersRoot = resolve(join(WORKS_ROOT, workId, "chapters"));
  const chapterDir = resolve(join(chaptersRoot, chapterId));
  if (!isPathInside(worksRoot, chaptersRoot) || chaptersRoot === worksRoot || !isPathInside(chaptersRoot, chapterDir) || chapterDir === chaptersRoot) {
    throw new Error("화 정보의 보관함 위치가 올바르지 않습니다.");
  }
}

function isSafeStoreId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}
