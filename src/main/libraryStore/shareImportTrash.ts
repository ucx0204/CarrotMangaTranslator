import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tMain } from "./localization";
import { WORKS_ROOT } from "./libraryFiles";
import { isPathInside } from "./storage";

export type TrashedChapterDirectory = {
  chapterId: string;
  sourceDir: string;
  trashDir: string;
  operationTrashRoot: string;
};

export async function moveOmittedExistingChaptersToTrash(
  workId: string,
  previousChapterIds: string[],
  finalChapterIds: string[],
): Promise<TrashedChapterDirectory[]> {
  const finalChapterIdSet = new Set(finalChapterIds);
  const operationId = randomUUID();
  const trashedChapters: TrashedChapterDirectory[] = [];

  for (const chapterId of previousChapterIds) {
    if (finalChapterIdSet.has(chapterId)) {
      continue;
    }

    const sourceDir = resolveChapterDirectory(workId, chapterId);
    if (!existsSync(sourceDir)) {
      continue;
    }

    const operationTrashRoot = resolveOperationTrashRoot(workId, operationId);
    const trashDir = resolve(join(operationTrashRoot, chapterId));
    if (
      !isPathInside(operationTrashRoot, trashDir) ||
      trashDir === operationTrashRoot
    ) {
      throw new Error(tMain("share.errors.invalidTrashLocation"));
    }

    await mkdir(operationTrashRoot, { recursive: true });
    await rename(sourceDir, trashDir);
    trashedChapters.push({
      chapterId,
      sourceDir,
      trashDir,
      operationTrashRoot,
    });
  }

  return trashedChapters;
}

export async function restoreTrashedChapterDirectories(
  workId: string,
  trashedChapters: TrashedChapterDirectory[],
): Promise<void> {
  for (const trashedChapter of [...trashedChapters].reverse()) {
    if (!existsSync(trashedChapter.trashDir)) {
      continue;
    }
    await mkdir(dirname(trashedChapter.sourceDir), { recursive: true });
    if (existsSync(trashedChapter.sourceDir)) {
      continue;
    }
    await rename(trashedChapter.trashDir, trashedChapter.sourceDir);
  }

  await pruneTrashRoots(workId, trashedChapters);
}

export async function discardTrashedChapterDirectories(
  workId: string,
  trashedChapters: TrashedChapterDirectory[],
): Promise<void> {
  const operationTrashRoots = new Set(
    trashedChapters.map((trashedChapter) => trashedChapter.operationTrashRoot),
  );
  for (const operationTrashRoot of operationTrashRoots) {
    await rm(operationTrashRoot, { recursive: true, force: true });
  }
  await removeDirectoryIfEmpty(resolveTrashRoot(workId));
}

async function pruneTrashRoots(
  workId: string,
  trashedChapters: TrashedChapterDirectory[],
): Promise<void> {
  const operationTrashRoots = new Set(
    trashedChapters.map((trashedChapter) => trashedChapter.operationTrashRoot),
  );
  for (const operationTrashRoot of operationTrashRoots) {
    await removeDirectoryIfEmpty(operationTrashRoot);
  }
  await removeDirectoryIfEmpty(resolveTrashRoot(workId));
}

async function removeDirectoryIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTEMPTY")
    ) {
      return;
    }
    throw error;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function resolveChapterDirectory(workId: string, chapterId: string): string {
  const chaptersRoot = resolve(join(WORKS_ROOT, workId, "chapters"));
  const chapterDir = resolve(join(chaptersRoot, chapterId));
  if (!isPathInside(chaptersRoot, chapterDir) || chapterDir === chaptersRoot) {
    throw new Error(tMain("share.errors.invalidChapterLocation"));
  }
  return chapterDir;
}

function resolveOperationTrashRoot(
  workId: string,
  operationId: string,
): string {
  const trashRoot = resolveTrashRoot(workId);
  const operationTrashRoot = resolve(join(trashRoot, operationId));
  if (
    !isPathInside(trashRoot, operationTrashRoot) ||
    operationTrashRoot === trashRoot
  ) {
    throw new Error(tMain("share.errors.invalidTrashLocation"));
  }
  return operationTrashRoot;
}

function resolveTrashRoot(workId: string): string {
  const chaptersRoot = resolve(join(WORKS_ROOT, workId, "chapters"));
  const trashRoot = resolve(join(chaptersRoot, ".trash"));
  if (!isPathInside(chaptersRoot, trashRoot) || trashRoot === chaptersRoot) {
    throw new Error(tMain("share.errors.invalidTrashLocation"));
  }
  return trashRoot;
}
