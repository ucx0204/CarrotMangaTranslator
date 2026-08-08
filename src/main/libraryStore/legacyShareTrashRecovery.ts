/* eslint-disable complexity, max-depth, max-lines-per-function -- legacy share-trash authority and conflict recovery stay co-located for auditability */
import { readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { readWorkFile } from "./libraryFiles";
import { logLibraryWarning } from "./libraryLogger";
import { getWorksRoot } from "./libraryPaths";
import { assertSafeStoreId } from "./libraryStoreIds";
import {
  assertDirectoryWithoutSymlink,
  durableRename,
  pathState,
  removeTree,
} from "./libraryTransactionStorage";

export type LegacyShareTrashRecoveryResult = {
  chaptersRestored: number;
  chaptersDiscarded: number;
};

export async function recoverLegacyShareImportTrash(): Promise<LegacyShareTrashRecoveryResult> {
  const result: LegacyShareTrashRecoveryResult = {
    chaptersRestored: 0,
    chaptersDiscarded: 0,
  };
  const worksRoot = getWorksRoot();
  if ((await pathState(worksRoot)) === "missing") {
    return result;
  }
  await assertDirectoryWithoutSymlink(worksRoot);

  const workEntries = await readdir(worksRoot, { withFileTypes: true });
  for (const workEntry of workEntries) {
    if (!workEntry.isDirectory() || workEntry.isSymbolicLink()) {
      continue;
    }
    try {
      assertSafeStoreId(workEntry.name, "작품 ID가 올바르지 않습니다.");
    } catch (error) {
      logLibraryWarning("Skipping legacy share trash for an unsafe work id", {
        workId: workEntry.name,
        error,
      });
      continue;
    }
    const work = await readWorkFile(workEntry.name);
    if (!work) {
      continue;
    }
    const trashRoot = join(worksRoot, work.id, "chapters", ".trash");
    if ((await pathState(trashRoot)) === "missing") {
      continue;
    }
    await assertDirectoryWithoutSymlink(trashRoot);
    const operationEntries = await readdir(trashRoot, { withFileTypes: true });
    for (const operationEntry of operationEntries) {
      if (!operationEntry.isDirectory() || operationEntry.isSymbolicLink()) {
        throw new Error(
          `legacy share trash에 안전하지 않은 entry가 있습니다: ${join(trashRoot, operationEntry.name)}`,
        );
      }
      const operationRoot = join(trashRoot, operationEntry.name);
      await assertDirectoryWithoutSymlink(operationRoot);
      const chapterEntries = await readdir(operationRoot, {
        withFileTypes: true,
      });
      for (const chapterEntry of chapterEntries) {
        if (!chapterEntry.isDirectory() || chapterEntry.isSymbolicLink()) {
          throw new Error(
            `legacy share trash chapter가 안전한 directory가 아닙니다: ${join(operationRoot, chapterEntry.name)}`,
          );
        }
        assertSafeStoreId(chapterEntry.name, "화 ID가 올바르지 않습니다.");
        const trashChapter = join(operationRoot, chapterEntry.name);
        const sourceChapter = join(
          worksRoot,
          work.id,
          "chapters",
          chapterEntry.name,
        );
        const sourceState = await pathState(sourceChapter);
        if (
          sourceState === "symlink" ||
          sourceState === "other" ||
          sourceState === "file"
        ) {
          throw new Error(
            `legacy share trash source 상태가 안전하지 않습니다: ${sourceChapter}`,
          );
        }
        if (work.chapterOrder.includes(chapterEntry.name)) {
          if (sourceState === "directory") {
            throw new Error(
              `legacy share trash conflict: source와 trash가 모두 존재합니다: ${chapterEntry.name}`,
            );
          }
          await durableRename(trashChapter, sourceChapter);
          result.chaptersRestored += 1;
        } else {
          await removeTree(trashChapter);
          result.chaptersDiscarded += 1;
        }
      }
      await removeDirectoryIfEmpty(operationRoot);
    }
    await removeDirectoryIfEmpty(trashRoot);
  }
  return result;
}

async function removeDirectoryIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ((error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ENOTEMPTY")
    ) {
      return;
    }
    throw error;
  }
}
