import type {
  WorkShareImportEntry,
  WorkShareImportFromPackageRequest,
  WorkShareImportResult,
} from "../../shared/types";
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
import type { SharePackage } from "./sharePackage";
import { makeUniqueTitleInList, sanitizeTitle } from "./titles";
import type { ZipArchiveReader } from "./zipSafety";

type ExistingShareImportPlan = {
  chapterByPackageId: Map<string, ChapterFile>;
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
  sharePackage: SharePackage,
  archiveReader: ZipArchiveReader,
  request: WorkShareImportFromPackageRequest,
): Promise<WorkShareImportResult> {
  if (request.target.mode !== "existing") {
    throw new Error("기존 작품 가져오기 요청이 아닙니다.");
  }

  const work = await ensureExistingWork(request.target.workId);
  const originalWork = cloneWorkForRollback(work);
  const currentChapters = await readCurrentChapters(work);
  const plan = createExistingShareImportPlan(sharePackage, currentChapters);
  const trashedExistingChapters: TrashedChapterDirectory[] = [];

  try {
    await populateExistingShareImportPlan({
      entries: request.entries,
      plan,
      workId: work.id,
      sharePackage,
      archiveReader,
    });
    return await commitExistingShareImport({
      work,
      plan,
      trashedExistingChapters,
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
): Promise<Map<string, ChapterFile>> {
  const currentChapters = new Map<string, ChapterFile>();
  for (const chapterId of work.chapterOrder) {
    const chapter = await readChapterFile(work.id, chapterId);
    if (chapter) {
      currentChapters.set(chapterId, chapter);
    }
  }
  return currentChapters;
}

function createExistingShareImportPlan(
  sharePackage: SharePackage,
  currentChapters: Map<string, ChapterFile>,
): ExistingShareImportPlan {
  return {
    chapterByPackageId: new Map(
      sharePackage.chapters.map((item) => [
        item.packageChapterId,
        item.chapter,
      ]),
    ),
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
  sharePackage,
  archiveReader,
}: {
  entries: WorkShareImportEntry[];
  plan: ExistingShareImportPlan;
  workId: string;
  sharePackage: SharePackage;
  archiveReader: ZipArchiveReader;
}): Promise<void> {
  for (const entry of entries) {
    await applyExistingShareEntry({
      entry,
      plan,
      workId,
      sharePackage,
      archiveReader,
    });
  }
}

async function applyExistingShareEntry({
  entry,
  plan,
  workId,
  sharePackage,
  archiveReader,
}: {
  entry: WorkShareImportEntry;
  plan: ExistingShareImportPlan;
  workId: string;
  sharePackage: SharePackage;
  archiveReader: ZipArchiveReader;
}): Promise<void> {
  if (entry.source === "existing") {
    addExistingChapterToPlan(entry, plan);
    return;
  }

  await addPackageChapterToPlan({
    entry,
    plan,
    workId,
    sharePackage,
    archiveReader,
  });
}

function addExistingChapterToPlan(
  entry: ExistingChapterEntry,
  plan: ExistingShareImportPlan,
): void {
  if (plan.usedExistingIds.has(entry.chapterId)) {
    throw new Error("같은 기존 화가 두 번 포함되어 있습니다.");
  }
  const currentChapter = plan.currentChapters.get(entry.chapterId);
  if (!currentChapter) {
    throw new Error("기존 작품에서 적용할 화를 찾지 못했습니다.");
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
  sharePackage,
  archiveReader,
}: {
  entry: PackageChapterEntry;
  plan: ExistingShareImportPlan;
  workId: string;
  sharePackage: SharePackage;
  archiveReader: ZipArchiveReader;
}): Promise<void> {
  if (plan.usedPackageIds.has(entry.packageChapterId)) {
    throw new Error("같은 공유 화가 두 번 포함되어 있습니다.");
  }
  const packageChapter = plan.chapterByPackageId.get(entry.packageChapterId);
  if (!packageChapter) {
    throw new Error("공유 파일에서 가져올 화를 찾지 못했습니다.");
  }

  const chapter = await materializeSharedChapter({
    workId,
    packageChapter,
    entries: sharePackage.entries,
    archiveReader,
    requestedTitle: makePlannedChapterTitle(
      entry.title,
      packageChapter.title,
      plan.usedTitles,
    ),
  });
  plan.createdPackageChapters.push(chapter);
  plan.usedPackageIds.add(entry.packageChapterId);
  plan.finalChapterIds.push(chapter.id);
}

function makePlannedChapterTitle(
  requestedTitle: string,
  fallbackTitle: string,
  usedTitles: Set<string>,
): string {
  return makeUniqueTitleInList(
    sanitizeTitle(requestedTitle || fallbackTitle, "제목없음"),
    usedTitles,
  );
}

async function commitExistingShareImport({
  work,
  plan,
  trashedExistingChapters,
}: {
  work: WorkFile;
  plan: ExistingShareImportPlan;
  trashedExistingChapters: TrashedChapterDirectory[];
}): Promise<WorkShareImportResult> {
  if (plan.finalChapterIds.length === 0) {
    throw new Error("적용할 화가 없습니다.");
  }

  const previousChapterIds = [...work.chapterOrder];
  await writeUpdatedExistingChapters(plan.updatedExistingChapters);
  await writeWorkFile({
    ...work,
    chapterOrder: plan.finalChapterIds,
    updatedAt: plan.now,
  });

  trashedExistingChapters.push(
    ...(await moveOmittedExistingChaptersToTrash(
      work.id,
      previousChapterIds,
      plan.finalChapterIds,
    )),
  );

  const openedChapter = await readOpenedImportedChapter(
    work.id,
    plan.finalChapterIds,
  );
  await discardTrashedChapterDirectories(work.id, trashedExistingChapters);
  return {
    workId: work.id,
    chapterIds: plan.finalChapterIds,
    openedChapter: hydrateChapter(openedChapter),
  };
}

async function writeUpdatedExistingChapters(
  chapters: ChapterFile[],
): Promise<void> {
  for (const chapter of chapters) {
    await writeChapterFile(chapter);
  }
}

async function readOpenedImportedChapter(
  workId: string,
  finalChapterIds: string[],
): Promise<ChapterFile> {
  const firstChapterId = finalChapterIds[0];
  if (!firstChapterId) {
    throw new Error("가져온 화를 열지 못했습니다.");
  }
  const openedChapter = await readChapterFile(workId, firstChapterId);
  if (!openedChapter) {
    throw new Error("가져온 화를 열지 못했습니다.");
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
