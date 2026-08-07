import { throwIfAborted } from "../abortSignal";
import type {
  WorkShareImportEntry,
  WorkShareImportFromPackageRequest,
  WorkShareImportResult,
} from "../../shared/shareTypes";
import { tMain } from "./localization";
import { safeCleanup } from "../safeCleanup";
import { hydrateChapter } from "./chapterSnapshots";
import {
  ensureExistingWork,
  readChapterFile,
  removeChapterDirectory,
  writeChapterFile,
  writeWorkFile,
  type ChapterFile,
  type WorkFile,
} from "./libraryFiles";
import { materializeSharedChapter } from "./shareImportMaterialize";
import {
  discardTrashedChapterDirectories,
  moveOmittedExistingChaptersToTrash,
  restoreTrashedChapterDirectories,
  type TrashedChapterDirectory,
} from "./shareImportTrash";
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
  throwIfAborted(signal);
  const originalWork = cloneWorkForRollback(work);
  const currentChapters = await readCurrentChapters(work, signal);
  throwIfAborted(signal);
  const plan = createExistingShareImportPlan(currentChapters);
  const trashedExistingChapters: TrashedChapterDirectory[] = [];

  try {
    await populateExistingShareImportPlan({
      entries: request.entries,
      plan,
      workId: work.id,
      session,
      signal,
    });
    throwIfAborted(signal);
    return await commitExistingShareImport({
      work,
      plan,
      trashedExistingChapters,
      signal,
    });
  } catch (error) {
    await rollbackExistingShareImport({
      work,
      originalWork,
      currentChapters,
      plan,
      trashedExistingChapters,
    });
    throw error;
  }
}

function cloneWorkForRollback(work: WorkFile): WorkFile {
  return {
    ...work,
    chapterOrder: [...work.chapterOrder],
  };
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
  signal,
}: {
  entries: WorkShareImportEntry[];
  plan: ExistingShareImportPlan;
  workId: string;
  session: SharePackageSession;
  signal?: AbortSignal;
}): Promise<void> {
  for (const entry of entries) {
    throwIfAborted(signal);
    await applyExistingShareEntry({
      entry,
      plan,
      workId,
      session,
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
  signal,
}: {
  entry: WorkShareImportEntry;
  plan: ExistingShareImportPlan;
  workId: string;
  session: SharePackageSession;
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

  const chapter = {
    ...currentChapter,
    title: makePlannedChapterTitle(
      entry.title,
      currentChapter.title,
      plan.usedTitles,
    ),
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
  signal,
}: {
  entry: PackageChapterEntry;
  plan: ExistingShareImportPlan;
  workId: string;
  session: SharePackageSession;
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

  const chapter = await materializeSharedChapter({
    workId,
    packageChapter,
    entries: session.entries,
    archiveReader: session.archiveReader,
    requestedTitle: makePlannedChapterTitle(
      entry.title,
      packageChapter.title,
      plan.usedTitles,
    ),
    signal,
  });
  // The directory and chapter file already exist. Register the resource in the
  // rollback journal before observing cancellation.
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

async function commitExistingShareImport({
  work,
  plan,
  trashedExistingChapters,
  signal,
}: {
  work: WorkFile;
  plan: ExistingShareImportPlan;
  trashedExistingChapters: TrashedChapterDirectory[];
  signal?: AbortSignal;
}): Promise<WorkShareImportResult> {
  if (plan.finalChapterIds.length === 0) {
    throw new Error(tMain("share.errors.noChaptersToApply"));
  }

  const previousChapterIds = [...work.chapterOrder];
  throwIfAborted(signal);
  await writeUpdatedExistingChapters(plan.updatedExistingChapters, signal);
  throwIfAborted(signal);
  await writeWorkFile({
    ...work,
    chapterOrder: plan.finalChapterIds,
    updatedAt: plan.now,
  });
  throwIfAborted(signal);

  trashedExistingChapters.push(
    ...(await moveOmittedExistingChaptersToTrash(
      work.id,
      previousChapterIds,
      plan.finalChapterIds,
    )),
  );
  throwIfAborted(signal);

  const openedChapter = await readOpenedImportedChapter(
    work.id,
    plan.finalChapterIds,
    signal,
  );
  throwIfAborted(signal);
  await discardTrashedChapterDirectories(work.id, trashedExistingChapters);
  return {
    workId: work.id,
    chapterIds: plan.finalChapterIds,
    openedChapter: hydrateChapter(openedChapter),
  };
}

async function writeUpdatedExistingChapters(
  chapters: ChapterFile[],
  signal?: AbortSignal,
): Promise<void> {
  for (const chapter of chapters) {
    throwIfAborted(signal);
    await writeChapterFile(chapter);
    throwIfAborted(signal);
  }
}

async function readOpenedImportedChapter(
  workId: string,
  finalChapterIds: string[],
  signal?: AbortSignal,
): Promise<ChapterFile> {
  const firstChapterId = finalChapterIds[0];
  if (!firstChapterId) {
    throw new Error(tMain("share.errors.importedChapterOpen"));
  }
  throwIfAborted(signal);
  const openedChapter = await readChapterFile(workId, firstChapterId);
  throwIfAborted(signal);
  if (!openedChapter) {
    throw new Error(tMain("share.errors.importedChapterOpen"));
  }
  return openedChapter;
}

async function rollbackExistingShareImport({
  work,
  originalWork,
  currentChapters,
  plan,
  trashedExistingChapters,
}: {
  work: WorkFile;
  originalWork: WorkFile;
  currentChapters: Map<string, ChapterFile>;
  plan: ExistingShareImportPlan;
  trashedExistingChapters: TrashedChapterDirectory[];
}): Promise<void> {
  await safeCleanup("restore-trashed-share-chapters", () =>
    restoreTrashedChapterDirectories(work.id, trashedExistingChapters),
  );
  for (const chapter of plan.createdPackageChapters) {
    await removeChapterDirectory(chapter.workId, chapter.id);
  }
  for (const chapter of plan.updatedExistingChapters) {
    const originalChapter = currentChapters.get(chapter.id);
    if (originalChapter) {
      await safeCleanup("restore-share-chapter-file", () =>
        writeChapterFile(originalChapter),
      );
    }
  }
  await safeCleanup("restore-share-work-file", () =>
    writeWorkFile(originalWork),
  );
}
