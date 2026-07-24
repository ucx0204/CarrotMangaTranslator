import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tMain } from "./localization";
import { getWorksRoot } from "./libraryPaths";
import { isPathInside } from "./storage";

export type TrashedChapterDirectory = {
  chapterId: string;
  sourceDir: string;
  trashDir: string;
  operationTrashRoot: string;
};

export type ShareImportTrashStorage = {
  exists(path: string): boolean;
  ensureDirectory(path: string): Promise<void>;
  move(sourcePath: string, destinationPath: string): Promise<void>;
  removeDirectoryTree(path: string): Promise<void>;
  removeEmptyDirectory(path: string): Promise<void>;
};

export type ShareImportTrashDependencies = {
  paths: {
    getWorksRoot(): string;
    isPathInside(rootPath: string, targetPath: string): boolean;
  };
  storage: ShareImportTrashStorage;
  localization: {
    translate(key: string): string;
  };
  createOperationId(): string;
};

export type ShareImportTrashService = {
  moveOmittedExistingChaptersToTrash(
    workId: string,
    previousChapterIds: string[],
    finalChapterIds: string[],
  ): Promise<TrashedChapterDirectory[]>;
  restoreTrashedChapterDirectories(
    workId: string,
    trashedChapters: TrashedChapterDirectory[],
  ): Promise<void>;
  discardTrashedChapterDirectories(
    workId: string,
    trashedChapters: TrashedChapterDirectory[],
  ): Promise<void>;
};

const productionDependencies: ShareImportTrashDependencies = {
  paths: { getWorksRoot, isPathInside },
  storage: {
    exists: existsSync,
    ensureDirectory: async (path) => {
      await mkdir(path, { recursive: true });
    },
    move: rename,
    removeDirectoryTree: async (path) => {
      await rm(path, { recursive: true, force: true });
    },
    removeEmptyDirectory: rmdir,
  },
  localization: { translate: tMain },
  createOperationId: randomUUID,
};

export function createShareImportTrashService(
  dependencies: ShareImportTrashDependencies,
): ShareImportTrashService {
  return {
    moveOmittedExistingChaptersToTrash: (
      workId,
      previousChapterIds,
      finalChapterIds,
    ) =>
      moveOmittedExistingChaptersToTrashWith(
        dependencies,
        workId,
        previousChapterIds,
        finalChapterIds,
      ),
    restoreTrashedChapterDirectories: (workId, trashedChapters) =>
      restoreTrashedChapterDirectoriesWith(
        dependencies,
        workId,
        trashedChapters,
      ),
    discardTrashedChapterDirectories: (workId, trashedChapters) =>
      discardTrashedChapterDirectoriesWith(
        dependencies,
        workId,
        trashedChapters,
      ),
  };
}

const productionService = createShareImportTrashService(productionDependencies);

export const moveOmittedExistingChaptersToTrash =
  productionService.moveOmittedExistingChaptersToTrash;
export const restoreTrashedChapterDirectories =
  productionService.restoreTrashedChapterDirectories;
export const discardTrashedChapterDirectories =
  productionService.discardTrashedChapterDirectories;

async function moveOmittedExistingChaptersToTrashWith(
  dependencies: ShareImportTrashDependencies,
  workId: string,
  previousChapterIds: string[],
  finalChapterIds: string[],
): Promise<TrashedChapterDirectory[]> {
  const finalChapterIdSet = new Set(finalChapterIds);
  const operationId = dependencies.createOperationId();
  const trashedChapters: TrashedChapterDirectory[] = [];

  try {
    for (const chapterId of previousChapterIds) {
      if (!finalChapterIdSet.has(chapterId)) {
        await moveChapterToTrash(
          dependencies,
          workId,
          operationId,
          chapterId,
          trashedChapters,
        );
      }
    }
    return trashedChapters;
  } catch (error) {
    await rollbackMoveFailure(dependencies, workId, trashedChapters, error);
    throw error;
  }
}

async function moveChapterToTrash(
  dependencies: ShareImportTrashDependencies,
  workId: string,
  operationId: string,
  chapterId: string,
  trashedChapters: TrashedChapterDirectory[],
): Promise<void> {
  const sourceDir = resolveChapterDirectory(dependencies, workId, chapterId);
  if (!dependencies.storage.exists(sourceDir)) {
    return;
  }

  const operationTrashRoot = resolveOperationTrashRoot(
    dependencies,
    workId,
    operationId,
  );
  const trashDir = resolve(join(operationTrashRoot, chapterId));
  assertInside(
    dependencies,
    operationTrashRoot,
    trashDir,
    "share.errors.invalidTrashLocation",
  );

  await dependencies.storage.ensureDirectory(operationTrashRoot);
  await dependencies.storage.move(sourceDir, trashDir);
  trashedChapters.push({
    chapterId,
    sourceDir,
    trashDir,
    operationTrashRoot,
  });
}

async function rollbackMoveFailure(
  dependencies: ShareImportTrashDependencies,
  workId: string,
  trashedChapters: TrashedChapterDirectory[],
  moveError: unknown,
): Promise<void> {
  if (trashedChapters.length === 0) {
    return;
  }
  try {
    await restoreTrashedChapterDirectoriesWith(
      dependencies,
      workId,
      trashedChapters,
    );
  } catch (restoreError) {
    throw new AggregateError(
      [moveError, restoreError],
      "공유 가져오기 휴지통 이동과 롤백이 모두 실패했습니다.",
      { cause: restoreError },
    );
  }
}

async function restoreTrashedChapterDirectoriesWith(
  dependencies: ShareImportTrashDependencies,
  workId: string,
  trashedChapters: TrashedChapterDirectory[],
): Promise<void> {
  assertTrashedChapterLocations(dependencies, workId, trashedChapters);

  for (const trashedChapter of [...trashedChapters].reverse()) {
    if (!dependencies.storage.exists(trashedChapter.trashDir)) {
      continue;
    }
    await dependencies.storage.ensureDirectory(
      dirname(trashedChapter.sourceDir),
    );
    if (!dependencies.storage.exists(trashedChapter.sourceDir)) {
      await dependencies.storage.move(
        trashedChapter.trashDir,
        trashedChapter.sourceDir,
      );
    }
  }

  await pruneTrashRoots(dependencies, workId, trashedChapters);
}

async function discardTrashedChapterDirectoriesWith(
  dependencies: ShareImportTrashDependencies,
  workId: string,
  trashedChapters: TrashedChapterDirectory[],
): Promise<void> {
  assertTrashedChapterLocations(dependencies, workId, trashedChapters);
  const operationTrashRoots = getOperationTrashRoots(trashedChapters);
  for (const operationTrashRoot of operationTrashRoots) {
    await dependencies.storage.removeDirectoryTree(operationTrashRoot);
  }
  await removeDirectoryIfEmpty(
    dependencies,
    resolveTrashRoot(dependencies, workId),
  );
}

async function pruneTrashRoots(
  dependencies: ShareImportTrashDependencies,
  workId: string,
  trashedChapters: TrashedChapterDirectory[],
): Promise<void> {
  for (const operationTrashRoot of getOperationTrashRoots(trashedChapters)) {
    await removeDirectoryIfEmpty(dependencies, operationTrashRoot);
  }
  await removeDirectoryIfEmpty(
    dependencies,
    resolveTrashRoot(dependencies, workId),
  );
}

function getOperationTrashRoots(
  trashedChapters: TrashedChapterDirectory[],
): Set<string> {
  return new Set(
    trashedChapters.map((trashedChapter) => trashedChapter.operationTrashRoot),
  );
}

async function removeDirectoryIfEmpty(
  dependencies: ShareImportTrashDependencies,
  path: string,
): Promise<void> {
  try {
    await dependencies.storage.removeEmptyDirectory(path);
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

function assertTrashedChapterLocations(
  dependencies: ShareImportTrashDependencies,
  workId: string,
  trashedChapters: TrashedChapterDirectory[],
): void {
  for (const trashedChapter of trashedChapters) {
    const expectedSource = resolveChapterDirectory(
      dependencies,
      workId,
      trashedChapter.chapterId,
    );
    const expectedTrash = resolve(
      join(trashedChapter.operationTrashRoot, trashedChapter.chapterId),
    );
    const trashRoot = resolveTrashRoot(dependencies, workId);
    if (
      trashedChapter.sourceDir !== expectedSource ||
      trashedChapter.trashDir !== expectedTrash ||
      !isStrictlyInside(
        dependencies,
        trashRoot,
        trashedChapter.operationTrashRoot,
      ) ||
      !isStrictlyInside(
        dependencies,
        trashedChapter.operationTrashRoot,
        trashedChapter.trashDir,
      )
    ) {
      throwInvalidLocation(dependencies, "share.errors.invalidTrashLocation");
    }
  }
}

function resolveChapterDirectory(
  dependencies: ShareImportTrashDependencies,
  workId: string,
  chapterId: string,
): string {
  const chaptersRoot = resolveChaptersRoot(dependencies, workId);
  const chapterDir = resolve(join(chaptersRoot, chapterId));
  assertInside(
    dependencies,
    chaptersRoot,
    chapterDir,
    "share.errors.invalidChapterLocation",
  );
  return chapterDir;
}

function resolveOperationTrashRoot(
  dependencies: ShareImportTrashDependencies,
  workId: string,
  operationId: string,
): string {
  const trashRoot = resolveTrashRoot(dependencies, workId);
  const operationTrashRoot = resolve(join(trashRoot, operationId));
  assertInside(
    dependencies,
    trashRoot,
    operationTrashRoot,
    "share.errors.invalidTrashLocation",
  );
  return operationTrashRoot;
}

function resolveTrashRoot(
  dependencies: ShareImportTrashDependencies,
  workId: string,
): string {
  const chaptersRoot = resolveChaptersRoot(dependencies, workId);
  const trashRoot = resolve(join(chaptersRoot, ".trash"));
  assertInside(
    dependencies,
    chaptersRoot,
    trashRoot,
    "share.errors.invalidTrashLocation",
  );
  return trashRoot;
}

function resolveChaptersRoot(
  dependencies: ShareImportTrashDependencies,
  workId: string,
): string {
  const worksRoot = resolve(dependencies.paths.getWorksRoot());
  const workRoot = resolve(join(worksRoot, workId));
  assertInside(
    dependencies,
    worksRoot,
    workRoot,
    "share.errors.invalidChapterLocation",
  );
  return resolve(join(workRoot, "chapters"));
}

function assertInside(
  dependencies: ShareImportTrashDependencies,
  rootPath: string,
  targetPath: string,
  errorKey: string,
): void {
  if (!isStrictlyInside(dependencies, rootPath, targetPath)) {
    throwInvalidLocation(dependencies, errorKey);
  }
}

function isStrictlyInside(
  dependencies: ShareImportTrashDependencies,
  rootPath: string,
  targetPath: string,
): boolean {
  return (
    targetPath !== rootPath &&
    dependencies.paths.isPathInside(rootPath, targetPath)
  );
}

function throwInvalidLocation(
  dependencies: ShareImportTrashDependencies,
  errorKey: string,
): never {
  throw new Error(dependencies.localization.translate(errorKey));
}
