import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ensureLibraryStructure,
  readIndexFile,
  readChapterFile,
  readWorkFile,
  removeChapterDirectory,
  removeWorkDirectory,
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
  await removeDanglingWorkDirectories(retainedWorkIds, result);

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

async function removeDanglingWorkDirectories(
  retainedWorkIds: string[],
  result: LibraryCleanupResult,
): Promise<void> {
  const retainedWorkIdSet = new Set(retainedWorkIds);
  const workEntries = await readdir(getWorksRoot(), { withFileTypes: true });
  for (const entry of workEntries) {
    if (!entry.isDirectory() || retainedWorkIdSet.has(entry.name)) {
      continue;
    }
    await removeWorkDirectory(entry.name);
    result.workDirsRemoved += 1;
  }
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
  await removeDanglingChapterDirectories(workId, retainedChapterIds, result);
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

async function removeDanglingChapterDirectories(
  workId: string,
  retainedChapterIds: string[],
  result: LibraryCleanupResult,
): Promise<void> {
  const chaptersRoot = join(getWorksRoot(), workId, "chapters");
  if (!existsSync(chaptersRoot)) {
    return;
  }

  const retainedChapterIdSet = new Set(retainedChapterIds);
  const chapterEntries = await readdir(chaptersRoot, { withFileTypes: true });
  for (const entry of chapterEntries) {
    if (!entry.isDirectory() || retainedChapterIdSet.has(entry.name)) {
      continue;
    }
    await removeChapterDirectory(workId, entry.name);
    result.chapterDirsRemoved += 1;
  }
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
