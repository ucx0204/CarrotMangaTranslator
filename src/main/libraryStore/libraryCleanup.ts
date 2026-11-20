import { existsSync } from "node:fs";
import { readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ensureLibraryStructure,
  readIndexFile,
  readChapterFile,
  readWorkFile,
  writeIndexFile,
  writeChapterFile,
  writeWorkFile,
} from "./libraryFiles";
import {
  getChapterFilePath,
  getWorkFilePath,
  getWorksRoot,
} from "./libraryPaths";
import {
  loadTranslationCheckpointArtifact,
  resolveManagedCheckpointDirectory,
} from "./translationCheckpointStore";

export type LibraryCleanupResult = {
  missingWorkReferencesRemoved: number;
  missingChapterReferencesRemoved: number;
  workDirsRemoved: number;
  chapterDirsRemoved: number;
  checkpointDirsRemoved: number;
};

export async function cleanupLibraryOrphansUnlocked(): Promise<LibraryCleanupResult> {
  await ensureLibraryStructure();
  const result = createLibraryCleanupResult();
  const retainedWorkIds = await removeMissingWorkReferences(result);
  result.workDirsRemoved = await removeEmptyUnlistedDirectories(
    getWorksRoot(),
    retainedWorkIds,
  );

  for (const workId of retainedWorkIds) {
    await cleanupWorkChapterReferences(workId, result);
  }

  return result;
}

function createLibraryCleanupResult(): LibraryCleanupResult {
  return {
    missingWorkReferencesRemoved: 0,
    missingChapterReferencesRemoved: 0,
    workDirsRemoved: 0,
    chapterDirsRemoved: 0,
    checkpointDirsRemoved: 0,
  };
}

async function removeMissingWorkReferences(
  result: LibraryCleanupResult,
): Promise<string[]> {
  const index = await readIndexFile();
  const retainedWorkIds: string[] = [];
  for (const workId of index.workOrder) {
    if (!existsSync(getWorkFilePath(workId))) {
      result.missingWorkReferencesRemoved += 1;
      continue;
    }
    retainedWorkIds.push(workId);
  }
  if (retainedWorkIds.length !== index.workOrder.length) {
    await writeIndexFile({ workOrder: retainedWorkIds });
  }
  return retainedWorkIds;
}

async function removeEmptyUnlistedDirectories(
  parent: string,
  retainedIds: string[],
): Promise<number> {
  if (!existsSync(parent)) return 0;
  const retained = new Set(retainedIds);
  let removed = 0;
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      retained.has(entry.name)
    )
      continue;
    try {
      // An incomplete index is never authorization to recursively delete user files.
      await rmdir(join(parent, entry.name));
      removed++;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT")
        throw error;
    }
  }
  return removed;
}

async function cleanupWorkChapterReferences(
  workId: string,
  result: LibraryCleanupResult,
): Promise<void> {
  const work = await readWorkFile(workId);
  if (!work) {
    return;
  }

  const retainedChapterIds = await removeMissingChapterReferences(
    workId,
    work.chapterOrder,
    result,
  );
  if (retainedChapterIds.length !== work.chapterOrder.length) {
    await writeWorkFile({
      ...work,
      chapterOrder: retainedChapterIds,
      updatedAt: new Date().toISOString(),
    });
  }
  result.chapterDirsRemoved += await removeEmptyUnlistedDirectories(
    join(getWorksRoot(), workId, "chapters"),
    retainedChapterIds,
  );
  for (const chapterId of retainedChapterIds) {
    await cleanupChapterCheckpoints(workId, chapterId, result);
  }
}

async function removeMissingChapterReferences(
  workId: string,
  chapterOrder: string[],
  result: LibraryCleanupResult,
): Promise<string[]> {
  const retainedChapterIds: string[] = [];
  for (const chapterId of chapterOrder) {
    if (!existsSync(getChapterFilePath(workId, chapterId))) {
      result.missingChapterReferencesRemoved += 1;
      continue;
    }
    retainedChapterIds.push(chapterId);
  }
  return retainedChapterIds;
}

async function cleanupChapterCheckpoints(
  workId: string,
  chapterId: string,
  result: LibraryCleanupResult,
): Promise<void> {
  const chapter = await readChapterFile(workId, chapterId);
  if (!chapter) return;
  const chapterDir = resolve(
    join(getWorksRoot(), workId, "chapters", chapterId),
  );
  const activeDirectories = new Set<string>();
  let metadataChanged = false;
  chapter.pages = await Promise.all(
    chapter.pages.map(async (page) => {
      if (!page.translationCheckpoint) return page;
      try {
        await loadTranslationCheckpointArtifact(chapterDir, {
          ...page,
          dataUrl: "",
        });
        activeDirectories.add(
          resolveManagedCheckpointDirectory(
            chapterDir,
            page.translationCheckpoint,
          ),
        );
        return page;
      } catch (error) {
        void error;
        metadataChanged = true;
        const { translationCheckpoint: _checkpoint, ...withoutCheckpoint } =
          page;
        return withoutCheckpoint;
      }
    }),
  );
  if (metadataChanged) {
    chapter.updatedAt = new Date().toISOString();
    await writeChapterFile(chapter);
  }
  const entries = await readdir(chapterDir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !entry.name.startsWith(".translation-checkpoint-")
    ) {
      continue;
    }
    const directory = resolve(join(chapterDir, entry.name));
    if (activeDirectories.has(directory)) continue;
    await rm(directory, { recursive: true, force: true });
    result.checkpointDirsRemoved += 1;
  }
}
