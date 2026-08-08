import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { throwIfAborted } from "../abortSignal";
import type {
  WorkShareImportEntry,
  WorkShareImportFromPackageRequest,
  WorkShareImportResult,
} from "../../shared/shareTypes";
import { tMain } from "./localization";
import { hydrateChapter } from "./chapterSnapshots";
import {
  ensureExistingWork,
  readChapterFile,
  type ChapterFile,
  type WorkFile,
} from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import {
  runLibraryTransaction,
  type LibraryTransaction,
} from "./libraryTransaction";
import { stageChapterFile, stageWorkFile } from "./libraryTransactionFiles";
import { materializeSharedChapter } from "./shareImportMaterialize";
import type { SharePackageSession } from "./sharePackage";
import { makeUniqueTitleInList, sanitizeTitle } from "./titles";

type ExistingShareImportPlan = {
  currentChapters: Map<string, ChapterFile>;
  usedTitles: Set<string>;
  usedExistingIds: Set<string>;
  usedPackageIds: Set<string>;
  finalChapterIds: string[];
  updatedExistingChapters: ChapterFile[];
  createdPackageChapters: ChapterFile[];
  now: string;
};

type ExistingChapterEntry = Extract<
  WorkShareImportEntry,
  { source: "existing" }
>;

type PackageChapterEntry = Extract<WorkShareImportEntry, { source: "package" }>;

export async function importWorkShareIntoExistingWork(
  session: SharePackageSession,
  request: WorkShareImportFromPackageRequest,
  signal?: AbortSignal,
): Promise<WorkShareImportResult> {
  if (request.target.mode !== "existing") {
    throw new Error(tMain("share.errors.notExistingWorkRequest"));
  }

  throwIfAborted(signal);
  const work = await ensureExistingWork(request.target.workId);
  const currentChapters = await readCurrentChapters(work, signal);
  throwIfAborted(signal);

  return runLibraryTransaction(
    "share-import-existing-work",
    async (transaction) => {
      const plan = createExistingShareImportPlan(currentChapters);
      await populateExistingShareImportPlan({
        entries: request.entries,
        plan,
        workId: work.id,
        session,
        transaction,
        signal,
      });
      throwIfAborted(signal);
      return stageExistingShareImport({
        transaction,
        work,
        plan,
        signal,
      });
    },
  );
}

async function readCurrentChapters(
  work: WorkFile,
  signal?: AbortSignal,
): Promise<Map<string, ChapterFile>> {
  const currentChapters = new Map<string, ChapterFile>();
  for (const chapterId of work.chapterOrder) {
    throwIfAborted(signal);
    const chapter = await readChapterFile(work.id, chapterId);
    throwIfAborted(signal);
    if (chapter) {
      currentChapters.set(chapterId, chapter);
    }
  }
  return currentChapters;
}

function createExistingShareImportPlan(
  currentChapters: Map<string, ChapterFile>,
): ExistingShareImportPlan {
  return {
    currentChapters,
    usedTitles: new Set<string>(),
    usedExistingIds: new Set<string>(),
    usedPackageIds: new Set<string>(),
    finalChapterIds: [],
    updatedExistingChapters: [],
    createdPackageChapters: [],
    now: new Date().toISOString(),
  };
}

async function populateExistingShareImportPlan({
  entries,
  plan,
  workId,
  session,
  transaction,
  signal,
}: {
  entries: WorkShareImportEntry[];
  plan: ExistingShareImportPlan;
  workId: string;
  session: SharePackageSession;
  transaction: LibraryTransaction;
  signal?: AbortSignal;
}): Promise<void> {
  for (const entry of entries) {
    throwIfAborted(signal);
    await applyExistingShareEntry({
      entry,
      plan,
      workId,
      session,
      transaction,
      signal,
    });
    throwIfAborted(signal);
  }
}

async function applyExistingShareEntry({
  entry,
  plan,
  workId,
  session,
  transaction,
  signal,
}: {
  entry: WorkShareImportEntry;
  plan: ExistingShareImportPlan;
  workId: string;
  session: SharePackageSession;
  transaction: LibraryTransaction;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(signal);
  if (entry.source === "existing") {
    addExistingChapterToPlan(entry, plan);
    return;
  }

  await addPackageChapterToPlan({
    entry,
    plan,
    workId,
    session,
    transaction,
    signal,
  });
}

function addExistingChapterToPlan(
  entry: ExistingChapterEntry,
  plan: ExistingShareImportPlan,
): void {
  if (plan.usedExistingIds.has(entry.chapterId)) {
    throw new Error(tMain("share.errors.duplicateExistingChapter"));
  }
  const currentChapter = plan.currentChapters.get(entry.chapterId);
  if (!currentChapter) {
    throw new Error(tMain("share.errors.existingChapterNotFound"));
  }

  const title = makePlannedChapterTitle(
    entry.title,
    currentChapter.title,
    plan.usedTitles,
  );
  plan.usedTitles.add(title);
  const chapter = {
    ...currentChapter,
    title,
    updatedAt: plan.now,
  };
  plan.updatedExistingChapters.push(chapter);
  plan.usedExistingIds.add(chapter.id);
  plan.finalChapterIds.push(chapter.id);
}

async function addPackageChapterToPlan({
  entry,
  plan,
  workId,
  session,
  transaction,
  signal,
}: {
  entry: PackageChapterEntry;
  plan: ExistingShareImportPlan;
  workId: string;
  session: SharePackageSession;
  transaction: LibraryTransaction;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(signal);
  if (plan.usedPackageIds.has(entry.packageChapterId)) {
    throw new Error(tMain("share.errors.duplicateSharedChapter"));
  }
  const packageChapter = await session.readChapter(
    entry.packageChapterId,
    signal,
  );
  const title = makePlannedChapterTitle(
    entry.title,
    packageChapter.title,
    plan.usedTitles,
  );
  plan.usedTitles.add(title);
  const chapterId = randomUUID();
  const finalChapterDirectory = join(
    getWorksRoot(),
    workId,
    "chapters",
    chapterId,
  );
  const published = await transaction.createPublishedDirectory(
    finalChapterDirectory,
  );
  const chapter = await materializeSharedChapter({
    workId,
    chapterId,
    packageChapter,
    entries: session.entries,
    archiveReader: session.archiveReader,
    requestedTitle: title,
    signal,
    writeChapterDirectory: published.stagingDirectory,
    publishedChapterDirectory: published.finalDirectory,
  });
  plan.createdPackageChapters.push(chapter);
  throwIfAborted(signal);
  plan.usedPackageIds.add(entry.packageChapterId);
  plan.finalChapterIds.push(chapter.id);
}

function makePlannedChapterTitle(
  requestedTitle: string,
  fallbackTitle: string,
  usedTitles: Set<string>,
): string {
  return makeUniqueTitleInList(
    sanitizeTitle(requestedTitle || fallbackTitle, tMain("import.untitled")),
    usedTitles,
  );
}

async function stageExistingShareImport({
  transaction,
  work,
  plan,
  signal,
}: {
  transaction: LibraryTransaction;
  work: WorkFile;
  plan: ExistingShareImportPlan;
  signal?: AbortSignal;
}): Promise<WorkShareImportResult> {
  if (plan.finalChapterIds.length === 0) {
    throw new Error(tMain("share.errors.noChaptersToApply"));
  }
  for (const chapter of plan.updatedExistingChapters) {
    throwIfAborted(signal);
    await stageChapterFile(transaction, chapter);
  }

  const nextWork: WorkFile = {
    ...work,
    chapterOrder: plan.finalChapterIds,
    updatedAt: plan.now,
  };
  await stageWorkFile(transaction, nextWork);

  const finalChapterIdSet = new Set(plan.finalChapterIds);
  for (const previousChapterId of work.chapterOrder) {
    if (finalChapterIdSet.has(previousChapterId)) {
      continue;
    }
    await transaction.retireDirectory(
      join(getWorksRoot(), work.id, "chapters", previousChapterId),
      { required: false },
    );
  }
  throwIfAborted(signal);

  const firstChapterId = plan.finalChapterIds[0];
  const openedChapter = [
    ...plan.updatedExistingChapters,
    ...plan.createdPackageChapters,
  ].find((chapter) => chapter.id === firstChapterId);
  if (!openedChapter) {
    throw new Error(tMain("share.errors.importedChapterOpen"));
  }
  return {
    workId: work.id,
    chapterIds: plan.finalChapterIds,
    openedChapter: hydrateChapter(openedChapter),
  };
}
