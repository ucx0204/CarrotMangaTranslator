import {
  preparePageDeletionUnlocked,
  stagePageDeletionUnlocked,
} from "./libraryPageDeletion";
import {
  prepareWorkDeletionUnlocked,
  stageWorkDeletionUnlocked,
} from "./libraryWorkDeletion";
import {
  prepareLibraryOrganizationUnlocked,
  commitLibraryOrganizationUnlocked,
} from "./libraryOrganization";
import {
  prepareChapterDeletionUnlocked,
  stageChapterDeletionUnlocked,
} from "./libraryChapterDeletion";
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
import { nextChapterUpdatedAt, resolveChapterStatus } from "./chapterRecords";
import { listLibrary } from "./libraryAccess";
import {
  findChapterLocation,
  readChapterFile,
  readWorkFile,
  type ChapterFile,
  type WorkFile,
} from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import {
  runLibraryTransaction,
  type LibraryTransaction,
} from "./libraryTransaction";
import { stageChapterFile, stageWorkFile } from "./libraryTransactionFiles";
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
  await commitLibraryOrganizationUnlocked(
    await prepareLibraryOrganizationUnlocked({
      kind: "rename-work",
      workId,
      title,
    }),
  );
  return listLibraryAfterCommittedMutation();
}

export async function renameChapterUnlocked(
  chapterId: string,
  title: string,
): Promise<LibraryIndex> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) throw new Error("화를 찾지 못했습니다.");
  await commitLibraryOrganizationUnlocked(
    await prepareLibraryOrganizationUnlocked({
      kind: "rename-chapter",
      workId: locator.workId,
      chapterId,
      title,
    }),
  );
  return listLibraryAfterCommittedMutation();
}

export async function deleteWorkUnlocked(
  workId: string,
): Promise<LibraryIndex> {
  const change = await prepareWorkDeletionUnlocked(workId);
  await runLibraryTransaction("delete-work", async (transaction) => {
    await stageWorkDeletionUnlocked(transaction, workId, change.after);
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
  const change = await prepareChapterDeletionUnlocked(
    locator.workId,
    locator.chapterId,
  );
  await runLibraryTransaction("delete-chapter", async (transaction) => {
    await stageChapterDeletionUnlocked(transaction, change.after, chapterId);
  });
  return listLibraryAfterCommittedMutation();
}

export async function reorderChaptersUnlocked(
  workId: string,
  chapterIds: string[],
): Promise<LibraryIndex> {
  await commitLibraryOrganizationUnlocked(
    await prepareLibraryOrganizationUnlocked({
      kind: "reorder-chapters",
      workId,
      chapterIds,
    }),
  );
  return listLibraryAfterCommittedMutation();
}

export async function reorderPagesUnlocked(
  chapterId: string,
  pageIds: string[],
): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const change = await prepareLibraryOrganizationUnlocked({
    kind: "reorder-pages",
    workId: locator.workId,
    chapterId,
    pageIds,
  });
  if (!change.after.chapter) throw new Error("Missing prepared chapter.");
  const snapshot = hydrateChapter(change.after.chapter);
  await commitLibraryOrganizationUnlocked(change);
  return snapshot;
}

export async function deletePageUnlocked(
  chapterId: string,
  pageId: string,
): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) throw new Error("화를 찾지 못했습니다.");
  const prepared = await preparePageDeletionUnlocked(
    locator.workId,
    chapterId,
    pageId,
  );
  const change = prepared.change;
  if (!change) return hydrateChapter(prepared.chapter);
  const snapshot = hydrateChapter(change.after.chapter);
  await runLibraryTransaction("delete-page", (transaction) =>
    stagePageDeletionUnlocked(transaction, change),
  );
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

  const now = nextChapterUpdatedAt(chapter);
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
  const now = nextChapterUpdatedAt(chapter);
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
    ...(update.page.typesettingMethod === "codex"
      ? {
          inpaintedImagePath: update.page.inpaintedImagePath,
          inpaintMaskPath: undefined,
          maskProvenance: "derived-diff" as const,
          typesettingMethod: update.page.typesettingMethod,
          blockOrder: update.page.blockOrder,
        }
      : {}),
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

  const now = nextChapterUpdatedAt(chapter);
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
