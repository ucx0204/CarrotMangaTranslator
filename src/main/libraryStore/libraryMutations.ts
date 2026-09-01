/* eslint-disable max-lines -- multi-file library mutation ordering stays co-located for transaction auditability */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ChapterSnapshot,
  LibraryIndex,
  LibraryPageRecord,
  MangaPage,
} from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import { hydrateChapter } from "./chapterSnapshots";
import {
  reorderIds,
  reorderRecords,
  resolveChapterStatus,
} from "./chapterRecords";
import { listLibrary } from "./libraryAccess";
import {
  findChapterLocation,
  getDefaultWorkTitle,
  makeUniqueChapterTitle,
  readChapterFile,
  readIndexFile,
  readWorkFile,
  writeWorkFile,
  type ChapterFile,
  type WorkFile,
} from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import {
  runLibraryTransaction,
  type LibraryTransaction,
} from "./libraryTransaction";
import {
  stageChapterFile,
  stageIndexFile,
  stageStoryMemoryFile,
  stageWorkFile,
} from "./libraryTransactionFiles";
import { sanitizeTitle } from "./titles";
import {
  readChapterStoryMemory,
  resolveReconciledStoryMemory,
} from "./workContextFiles";
import { resolveManagedCheckpointDirectory } from "./translationCheckpointStore";

export type PageAnalysisUpdate = {
  expectedRevision?: PageRevision;
  expectedUpdatedAt?: string;
  page: MangaPage;
  warnings: string[];
  status: "completed" | "failed";
};

const ANALYSIS_UPDATE_CONFLICT_MESSAGE =
  "사용자 편집으로 자동 번역 결과를 적용하지 않았습니다.";

export async function renameWorkUnlocked(
  workId: string,
  title: string,
): Promise<LibraryIndex> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  work.title = sanitizeTitle(title, getDefaultWorkTitle());
  work.updatedAt = new Date().toISOString();
  await writeWorkFile(work);
  return listLibrary();
}

export async function renameChapterUnlocked(
  chapterId: string,
  title: string,
): Promise<LibraryIndex> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }
  chapter.title = await makeUniqueChapterTitle(
    locator.workId,
    sanitizeTitle(title, "제목없음"),
    chapter.id,
  );
  chapter.updatedAt = new Date().toISOString();
  await runLibraryTransaction("rename-chapter", async (transaction) => {
    await stageChapterAndTouchedWork(transaction, chapter, chapter.updatedAt);
  });
  return listLibraryAfterCommittedMutation();
}

export async function deleteWorkUnlocked(
  workId: string,
): Promise<LibraryIndex> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  const index = await readIndexFile();
  const nextIndex = {
    workOrder: index.workOrder.filter((id) => id !== workId),
  };

  await runLibraryTransaction("delete-work", async (transaction) => {
    await stageIndexFile(transaction, nextIndex);
    await transaction.retireDirectory(join(getWorksRoot(), workId), {
      required: true,
    });
  });
  return listLibraryAfterCommittedMutation();
}

export async function deleteChapterUnlocked(
  chapterId: string,
): Promise<LibraryIndex> {
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

  const nextWork: WorkFile = {
    ...work,
    chapterOrder: work.chapterOrder.filter((id) => id !== chapter.id),
    updatedAt: new Date().toISOString(),
  };
  await runLibraryTransaction("delete-chapter", async (transaction) => {
    await stageWorkFile(transaction, nextWork);
    await transaction.retireDirectory(
      join(getWorksRoot(), locator.workId, "chapters", locator.chapterId),
      { required: true },
    );
  });
  return listLibraryAfterCommittedMutation();
}

export async function reorderChaptersUnlocked(
  workId: string,
  chapterIds: string[],
): Promise<LibraryIndex> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  work.chapterOrder = reorderIds(work.chapterOrder, chapterIds);
  work.updatedAt = new Date().toISOString();
  await writeWorkFile(work);
  return listLibrary();
}

export async function reorderPagesUnlocked(
  chapterId: string,
  pageIds: string[],
): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const work = await requireWork(locator.workId);
  const currentMemory = await readChapterStoryMemory(chapter.id);
  const now = new Date().toISOString();
  chapter.pageOrder = reorderIds(chapter.pageOrder, pageIds);
  chapter.pages = reorderRecords(chapter.pages, chapter.pageOrder);
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  const nextMemory = resolveReconciledStoryMemory(
    currentMemory,
    chapter.pages,
    now,
  );
  const nextWork = { ...work, updatedAt: now };
  const snapshot = hydrateChapter(chapter);

  await runLibraryTransaction("reorder-pages", async (transaction) => {
    await stageChapterFile(transaction, chapter);
    if (nextMemory !== currentMemory) {
      await stageStoryMemoryFile(transaction, nextMemory);
    }
    await stageWorkFile(transaction, nextWork);
  });
  return snapshot;
}

export async function deletePageUnlocked(
  chapterId: string,
  pageId: string,
): Promise<ChapterSnapshot> {
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
  const work = await requireWork(locator.workId);
  const currentMemory = await readChapterStoryMemory(chapter.id);
  const artifactDirectories = await collectPageArtifactDirectories(
    locator.workId,
    locator.chapterId,
    pageId,
  );
  if (target.translationCheckpoint) {
    artifactDirectories.push(
      resolveManagedCheckpointDirectory(
        join(getWorksRoot(), locator.workId, "chapters", locator.chapterId),
        target.translationCheckpoint,
      ),
    );
  }
  const now = new Date().toISOString();
  chapter.pageOrder = chapter.pageOrder.filter((id) => id !== pageId);
  chapter.pages = chapter.pages.filter((page) => page.id !== pageId);
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  const nextMemory = resolveReconciledStoryMemory(
    currentMemory,
    chapter.pages,
    now,
  );
  const nextWork = { ...work, updatedAt: now };
  const snapshot = hydrateChapter(chapter);

  await runLibraryTransaction("delete-page", async (transaction) => {
    await stageChapterFile(transaction, chapter);
    if (nextMemory !== currentMemory) {
      await stageStoryMemoryFile(transaction, nextMemory);
    }
    await stageWorkFile(transaction, nextWork);
    await transaction.retireFile(target.imagePath, { required: false });
    if (target.inpaintedImagePath) {
      await transaction.retireFile(target.inpaintedImagePath, {
        required: false,
      });
    }
    for (const artifactDirectory of artifactDirectories) {
      await transaction.retireDirectory(artifactDirectory, { required: false });
    }
  });
  return snapshot;
}

export async function markChapterPagesRunningUnlocked(
  chapterId: string,
  pageIds: string[],
): Promise<ChapterSnapshot> {
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
        }
      : page,
  );
  chapter.status = resolveChapterStatus(chapter.pages);
  chapter.updatedAt = now;
  const snapshot = hydrateChapter(chapter);
  await runLibraryTransaction("mark-pages-running", async (transaction) => {
    await stageChapterAndTouchedWork(transaction, chapter, now);
  });
  return snapshot;
}

export async function updatePagesAfterAnalysisUnlocked(
  chapterId: string,
  updates: PageAnalysisUpdate[],
): Promise<Set<string>> {
  const appliedPageIds = new Set<string>();
  if (updates.length === 0) {
    return appliedPageIds;
  }
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    return appliedPageIds;
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    return appliedPageIds;
  }

  const updatesByPageId = new Map(
    updates.map((update) => [update.page.id, update]),
  );
  const checkpointDirectoriesToRetire: string[] = [];
  const chapterDir = join(
    getWorksRoot(),
    locator.workId,
    "chapters",
    locator.chapterId,
  );
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((record) =>
    applyPageAnalysisUpdate({
      appliedPageIds,
      chapterDir,
      checkpointDirectoriesToRetire,
      now,
      record,
      update: updatesByPageId.get(record.id),
    }),
  );
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await runLibraryTransaction(
    "update-pages-after-analysis",
    async (transaction) => {
      await stageChapterAndTouchedWork(transaction, chapter, now);
      for (const checkpointDirectory of checkpointDirectoriesToRetire) {
        await transaction.retireDirectory(checkpointDirectory, {
          required: false,
        });
      }
    },
  );
  return appliedPageIds;
}

function applyPageAnalysisUpdate({
  appliedPageIds,
  chapterDir,
  checkpointDirectoriesToRetire,
  now,
  record,
  update,
}: {
  appliedPageIds: Set<string>;
  chapterDir: string;
  checkpointDirectoriesToRetire: string[];
  now: string;
  record: LibraryPageRecord;
  update?: PageAnalysisUpdate;
}): LibraryPageRecord {
  if (!update) return record;
  const revisionConflict = update.expectedRevision
    ? createPageRevision(record) !== update.expectedRevision
    : Boolean(
        update.expectedUpdatedAt &&
        record.updatedAt !== update.expectedUpdatedAt,
      );
  if (revisionConflict) {
    return {
      ...record,
      analysisStatus: "failed",
      lastError: ANALYSIS_UPDATE_CONFLICT_MESSAGE,
    };
  }
  appliedPageIds.add(record.id);
  if (update.status === "failed") {
    return {
      ...record,
      analysisStatus: "failed",
      lastError: update.warnings[update.warnings.length - 1],
    };
  }
  if (record.translationCheckpoint) {
    checkpointDirectoriesToRetire.push(
      resolveManagedCheckpointDirectory(
        chapterDir,
        record.translationCheckpoint,
      ),
    );
  }
  return {
    ...record,
    blocks: update.page.blocks,
    soundEffectReview: update.page.soundEffectReview,
    analysisStatus: "completed",
    translationCompletion: update.page.translationCompletion,
    translationCheckpoint: undefined,
    fontContinuity: update.page.fontContinuity,
    processingTiming: update.page.processingTiming,
    lastError: undefined,
    updatedAt: now,
  };
}

export async function updatePageAfterAnalysisUnlocked(
  chapterId: string,
  page: MangaPage,
  warnings: string[],
  status: "completed" | "failed",
  expectedUpdatedAt?: string,
  expectedRevision?: PageRevision,
): Promise<boolean> {
  const appliedPageIds = await updatePagesAfterAnalysisUnlocked(chapterId, [
    { page, warnings, status, expectedUpdatedAt, expectedRevision },
  ]);
  return appliedPageIds.has(page.id);
}

export async function finalizeRunningPagesUnlocked(
  chapterId: string,
  pageIds: string[],
  status: "idle" | "failed",
  errorMessage?: string,
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
        }
      : page,
  );
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await runLibraryTransaction("finalize-running-pages", async (transaction) => {
    await stageChapterAndTouchedWork(transaction, chapter, now);
  });
}

async function stageChapterAndTouchedWork(
  transaction: LibraryTransaction,
  chapter: ChapterFile,
  updatedAt: string,
): Promise<void> {
  const work = await requireWork(chapter.workId);
  await stageChapterFile(transaction, chapter);
  await stageWorkFile(transaction, { ...work, updatedAt });
}

async function requireWork(workId: string): Promise<WorkFile> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  return work;
}

async function collectPageArtifactDirectories(
  workId: string,
  chapterId: string,
  pageId: string,
): Promise<string[]> {
  const runsRoot = join(getWorksRoot(), workId, "chapters", chapterId, "runs");
  let runs: Dirent<string>[];
  try {
    runs = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  return runs
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => join(runsRoot, entry.name, "pages", pageId));
}

async function listLibraryAfterCommittedMutation(): Promise<LibraryIndex> {
  try {
    return await listLibrary();
  } catch (error) {
    const wrapped = new Error(
      "보관함 변경은 완료됐지만 목록을 새로고치지 못했습니다.",
      { cause: error },
    ) as Error & { mutationCommitted: true };
    wrapped.mutationCommitted = true;
    throw wrapped;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
