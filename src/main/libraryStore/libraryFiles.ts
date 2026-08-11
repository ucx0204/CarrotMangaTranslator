import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  LibraryChapterFileSchema,
  LibraryWorkFileSchema,
  StoredLibraryIndexFileSchema,
} from "../../shared/ipcSchemas";
import type { LibraryChapter, LibraryWork } from "../../shared/libraryTypes";
import { tMain } from "./localization";
import { relocateCopiedChapterImagePath } from "./chapterImageRelocation";
import { assertUniqueIds, readLibraryJsonFile } from "./libraryJsonValidation";
import { assertSafeStoreId } from "./libraryStoreIds";
import {
  isPathInside,
  isSupportedImagePath,
  readJsonFile,
  writeJsonFile,
} from "./storage";
import { makeUniqueTitleInList, sanitizeTitle } from "./titles";
import {
  getLibraryIndexPath,
  getLibraryRoot,
  getChapterFilePath,
  getWorkFilePath,
  getWorksRoot,
} from "./libraryPaths";

export function getDefaultWorkTitle(): string {
  return tMain("import.defaultWorkTitle");
}

export type StoredIndexFile = {
  workOrder: string[];
};

export type WorkFile = LibraryWork;
export type ChapterFile = LibraryChapter;

export type ChapterRunPaths = {
  chapterDir: string;
  runDir: string;
};

export function assertLibraryImagePath(imagePath: string): string {
  const resolvedImagePath = assertLibraryImagePathScope(imagePath);
  if (!existsSync(resolvedImagePath)) {
    throw new Error("페이지 이미지 파일을 찾지 못했습니다.");
  }
  return resolvedImagePath;
}

function assertLibraryImagePathScope(
  imagePath: string,
  message = "보관함 밖의 이미지는 열 수 없습니다.",
): string {
  if (typeof imagePath !== "string" || imagePath.length === 0) {
    throw new Error(message);
  }
  const resolvedRoot = resolve(getLibraryRoot());
  const resolvedImagePath = resolve(imagePath);
  if (!isPathInside(resolvedRoot, resolvedImagePath)) {
    throw new Error(message);
  }
  if (!isSupportedImagePath(resolvedImagePath)) {
    throw new Error("지원하지 않는 이미지 형식입니다.");
  }
  return resolvedImagePath;
}

export function assertChapterImagePath(
  workId: string,
  chapterId: string,
  imagePath: string,
  message: string,
): string {
  const resolvedImagePath = assertChapterImagePathScope(
    workId,
    chapterId,
    imagePath,
    message,
  );
  if (!existsSync(resolvedImagePath)) {
    throw new Error("페이지 이미지 파일을 찾지 못했습니다.");
  }
  return resolvedImagePath;
}

function assertChapterImagePathScope(
  workId: string,
  chapterId: string,
  imagePath: string,
  message: string,
): string {
  const resolvedImagePath = assertLibraryImagePathScope(imagePath, message);
  const chapterDir = resolve(
    join(getWorksRoot(), workId, "chapters", chapterId),
  );
  if (!isPathInside(chapterDir, resolvedImagePath)) {
    throw new Error(message);
  }
  return resolvedImagePath;
}

export async function readIndexFile(): Promise<StoredIndexFile> {
  await ensureLibraryStructure();
  return validateIndexFile(
    readLibraryJsonFile(
      StoredLibraryIndexFileSchema,
      await readJsonFile<unknown>(getLibraryIndexPath(), { workOrder: [] }),
    ),
  );
}

export async function writeIndexFile(index: StoredIndexFile): Promise<void> {
  await ensureLibraryStructure();
  await writeJsonFile(
    getLibraryIndexPath(),
    validateIndexFile(readLibraryJsonFile(StoredLibraryIndexFileSchema, index)),
  );
}

export async function readWorkFile(workId: string): Promise<WorkFile | null> {
  const work = await readJsonFile<unknown | null>(
    getWorkFilePath(workId),
    null,
  );
  return work
    ? validateWorkFile(workId, readLibraryJsonFile(LibraryWorkFileSchema, work))
    : null;
}

export async function writeWorkFile(work: WorkFile): Promise<void> {
  const checkedWork = validateWorkFile(
    work.id,
    readLibraryJsonFile(LibraryWorkFileSchema, work),
  );
  await mkdir(dirname(getWorkFilePath(checkedWork.id)), { recursive: true });
  await writeJsonFile(getWorkFilePath(checkedWork.id), checkedWork);
}

export async function readChapterFile(
  workId: string,
  chapterId: string,
): Promise<ChapterFile | null> {
  const chapter = await readJsonFile<unknown | null>(
    getChapterFilePath(workId, chapterId),
    null,
  );
  return chapter
    ? validateChapterFilePaths(
        workId,
        chapterId,
        readLibraryJsonFile(LibraryChapterFileSchema, chapter),
      )
    : null;
}

export async function writeChapterFile(chapter: ChapterFile): Promise<void> {
  const checkedChapter = validateChapterFilePaths(
    chapter.workId,
    chapter.id,
    readLibraryJsonFile(LibraryChapterFileSchema, chapter),
  );
  await mkdir(
    dirname(getChapterFilePath(checkedChapter.workId, checkedChapter.id)),
    { recursive: true },
  );
  await writeJsonFile(
    getChapterFilePath(checkedChapter.workId, checkedChapter.id),
    checkedChapter,
  );
}

export async function findChapterLocation(
  chapterId: string,
): Promise<{ workId: string; chapterId: string } | null> {
  const index = await readIndexFile();
  const workReads = await Promise.allSettled(
    index.workOrder.map((workId) => readWorkFile(workId)),
  );
  for (const [indexPosition, outcome] of workReads.entries()) {
    if (outcome.status === "rejected") {
      throw outcome.reason;
    }
    const workId = index.workOrder[indexPosition];
    const work = outcome.value;
    if (!work) {
      continue;
    }
    if (workId && work.chapterOrder.includes(chapterId)) {
      return { workId, chapterId };
    }
  }
  return null;
}

export async function ensureLibraryStructure(): Promise<void> {
  await mkdir(getWorksRoot(), { recursive: true });
}

export function createUnpublishedWork(title: string): LibraryWork {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: sanitizeTitle(title, getDefaultWorkTitle()),
    chapterOrder: [],
    readingDirection: "auto",
    createdAt: now,
    updatedAt: now,
  };
}

export async function ensureExistingWork(workId: string): Promise<LibraryWork> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("선택한 작품을 찾지 못했습니다.");
  }
  return work;
}

export async function collectUsedChapterTitles(
  workId: string,
  excludeChapterId?: string,
): Promise<Set<string>> {
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

export async function makeUniqueChapterTitle(
  workId: string,
  desired: string,
  excludeChapterId?: string,
): Promise<string> {
  const used = await collectUsedChapterTitles(workId, excludeChapterId);
  return makeUniqueTitleInList(desired, used);
}

export async function removeWorkDirectory(workId: string): Promise<void> {
  const worksRoot = resolve(getWorksRoot());
  const workDir = resolve(join(worksRoot, workId));
  if (!isPathInside(worksRoot, workDir) || workDir === worksRoot) {
    return;
  }
  if (existsSync(workDir)) {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function removeChapterDirectory(
  workId: string,
  chapterId: string,
): Promise<void> {
  const chaptersRoot = resolve(join(getWorksRoot(), workId, "chapters"));
  const chapterDir = resolve(join(chaptersRoot, chapterId));
  if (!isPathInside(chaptersRoot, chapterDir) || chapterDir === chaptersRoot) {
    return;
  }
  if (existsSync(chapterDir)) {
    await rm(chapterDir, { recursive: true, force: true });
  }
}

export function validateChapterFilePaths(
  workId: string,
  chapterId: string,
  chapter: ChapterFile,
): ChapterFile {
  assertChapterStorageLocation(workId, chapterId);
  if (chapter.workId !== workId || chapter.id !== chapterId) {
    throw new Error("화 정보의 보관함 위치가 올바르지 않습니다.");
  }
  assertUniqueIds(
    chapter.pageOrder,
    "페이지 순서에 중복된 페이지 ID가 있습니다.",
  );

  const pageIds = new Set<string>();
  const pages = chapter.pages.map((page) => {
    if (pageIds.has(page.id)) {
      throw new Error("중복된 페이지 ID가 있습니다.");
    }
    pageIds.add(page.id);

    return {
      ...page,
      imagePath: resolveChapterStoredImagePath(
        workId,
        chapterId,
        page.imagePath,
        "페이지 이미지 경로가 올바르지 않습니다.",
      ),
      inpaintedImagePath: page.inpaintedImagePath
        ? resolveChapterStoredImagePath(
            workId,
            chapterId,
            page.inpaintedImagePath,
            "인페인팅 결과 이미지 경로가 올바르지 않습니다.",
          )
        : undefined,
    };
  });

  for (const pageId of chapter.pageOrder) {
    if (!pageIds.has(pageId)) {
      throw new Error("페이지 순서 정보가 페이지 목록과 맞지 않습니다.");
    }
  }

  return {
    ...chapter,
    pages,
  };
}

export function validateIndexFile(index: StoredIndexFile): StoredIndexFile {
  assertUniqueIds(index.workOrder, "작품 순서에 중복된 작품 ID가 있습니다.");
  return index;
}

export function validateWorkFile(workId: string, work: WorkFile): WorkFile {
  assertSafeStoreId(workId, "작품 ID가 올바르지 않습니다.");
  if (work.id !== workId) {
    throw new Error("작품 정보의 보관함 위치가 올바르지 않습니다.");
  }
  assertUniqueIds(work.chapterOrder, "화 순서에 중복된 화 ID가 있습니다.");
  return work;
}

function resolveChapterStoredImagePath(
  workId: string,
  chapterId: string,
  imagePath: string,
  message: string,
): string {
  try {
    return assertChapterImagePathScope(workId, chapterId, imagePath, message);
  } catch (error) {
    const relocated = relocateCopiedChapterImagePath({
      worksRoot: getWorksRoot(),
      workId,
      chapterId,
      imagePath,
    });
    if (relocated) {
      return assertChapterImagePathScope(workId, chapterId, relocated, message);
    }
    throw error;
  }
}

function assertChapterStorageLocation(workId: string, chapterId: string): void {
  assertSafeStoreId(workId, "화 정보의 보관함 위치가 올바르지 않습니다.");
  assertSafeStoreId(chapterId, "화 정보의 보관함 위치가 올바르지 않습니다.");
  const worksRoot = resolve(getWorksRoot());
  const chaptersRoot = resolve(join(worksRoot, workId, "chapters"));
  const chapterDir = resolve(join(chaptersRoot, chapterId));
  if (
    !isPathInside(worksRoot, chaptersRoot) ||
    chaptersRoot === worksRoot ||
    !isPathInside(chaptersRoot, chapterDir) ||
    chapterDir === chaptersRoot
  ) {
    throw new Error("화 정보의 보관함 위치가 올바르지 않습니다.");
  }
}
