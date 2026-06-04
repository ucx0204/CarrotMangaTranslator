import { join, resolve } from "node:path";
import type { ChapterSnapshot, LibraryIndex, MangaPage, SavePageBlocksRequest } from "../../shared/types";
import { normalizeBlockType } from "../../shared/geometry";
import { hydrateChapter, toStoredChapter, validateChapterSnapshotForStorage } from "./chapterSnapshots";
import { collectManagedInpaintedArtifacts, inpaintedPathChanged, removeUnreferencedInpaintedArtifacts } from "./inpaintedArtifacts";
import { reorderIds, reorderRecords, resolveChapterStatus } from "./chapterRecords";
import { listLibrary } from "./libraryAccess";
import {
  DEFAULT_WORK_TITLE,
  WORKS_ROOT,
  assertChapterImagePath,
  findChapterLocation,
  makeUniqueChapterTitle,
  readChapterFile,
  readIndexFile,
  readWorkFile,
  removeChapterDirectory,
  removePageArtifacts,
  removeWorkDirectory,
  touchWork,
  writeChapterFile,
  writeIndexFile,
  writeWorkFile,
  type ChapterFile
} from "./libraryFiles";
import { safeUnlink } from "./storage";
import { sanitizeTitle } from "./titles";

export type InpaintingArtifactCleanupOptions = {
  retainedInpaintedArtifactPaths?: string[];
};

export async function saveChapterSnapshotUnlocked(snapshot: ChapterSnapshot): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(snapshot.id);
  if (!locator || locator.workId !== snapshot.workId) {
    throw new Error("저장할 화의 보관함 위치가 올바르지 않습니다.");
  }
  const current = await readChapterFile(locator.workId, locator.chapterId);
  if (!current) {
    throw new Error("저장할 화를 찾지 못했습니다.");
  }
  validateChapterSnapshotForStorage(snapshot, current, assertChapterImagePath);
  const stored = toStoredChapter(snapshot, current);
  await writeChapterFile(stored);
  return hydrateChapter(stored);
}

export async function savePageBlocksUnlocked(request: SavePageBlocksRequest): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(request.chapterId);
  if (!locator) {
    throw new Error("저장할 화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("저장할 화를 찾지 못했습니다.");
  }
  const page = chapter.pages.find((candidate) => candidate.id === request.pageId);
  if (!page) {
    throw new Error("저장할 페이지를 찾지 못했습니다.");
  }

  const now = new Date().toISOString();
  const pages = chapter.pages.map((candidate) =>
    candidate.id === request.pageId
      ? {
          ...candidate,
          blocks: request.blocks.map((block) => ({
            ...block,
            type: normalizeBlockType(block.type)
          })),
          updatedAt: now
        }
      : candidate
  );
  const nextChapter: ChapterFile = {
    ...chapter,
    pages,
    status: resolveChapterStatus(pages),
    updatedAt: now
  };
  await writeChapterFile(nextChapter);
  return hydrateChapter(nextChapter);
}

export async function renameWorkUnlocked(workId: string, title: string): Promise<LibraryIndex> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  work.title = sanitizeTitle(title, DEFAULT_WORK_TITLE);
  work.updatedAt = new Date().toISOString();
  await writeWorkFile(work);
  return listLibrary();
}

export async function renameChapterUnlocked(chapterId: string, title: string): Promise<LibraryIndex> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }
  chapter.title = await makeUniqueChapterTitle(locator.workId, sanitizeTitle(title, "제목없음"), chapter.id);
  chapter.updatedAt = new Date().toISOString();
  await writeChapterFile(chapter);
  await touchWork(locator.workId, chapter.updatedAt);
  return listLibrary();
}

export async function deleteWorkUnlocked(workId: string): Promise<LibraryIndex> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }

  const index = await readIndexFile();
  index.workOrder = index.workOrder.filter((id) => id !== workId);
  await writeIndexFile(index);
  await removeWorkDirectory(workId);

  return listLibrary();
}

export async function deleteChapterUnlocked(chapterId: string): Promise<LibraryIndex> {
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

  work.chapterOrder = work.chapterOrder.filter((id) => id !== chapter.id);
  work.updatedAt = new Date().toISOString();
  await writeWorkFile(work);
  await removeChapterDirectory(locator.workId, locator.chapterId);

  return listLibrary();
}

export async function reorderChaptersUnlocked(workId: string, chapterIds: string[]): Promise<LibraryIndex> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  work.chapterOrder = reorderIds(work.chapterOrder, chapterIds);
  work.updatedAt = new Date().toISOString();
  await writeWorkFile(work);
  return listLibrary();
}

export async function reorderPagesUnlocked(chapterId: string, pageIds: string[]): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }
  chapter.pageOrder = reorderIds(chapter.pageOrder, pageIds);
  chapter.pages = reorderRecords(chapter.pages, chapter.pageOrder);
  chapter.updatedAt = new Date().toISOString();
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, chapter.updatedAt);
  return hydrateChapter(chapter);
}

export async function deletePageUnlocked(chapterId: string, pageId: string): Promise<ChapterSnapshot> {
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

  chapter.pageOrder = chapter.pageOrder.filter((id) => id !== pageId);
  chapter.pages = chapter.pages.filter((page) => page.id !== pageId);
  chapter.updatedAt = new Date().toISOString();
  chapter.status = resolveChapterStatus(chapter.pages);

  await writeChapterFile(chapter);
  await touchWork(locator.workId, chapter.updatedAt);
  await safeUnlink(target.imagePath);
  if (target.inpaintedImagePath) {
    await safeUnlink(target.inpaintedImagePath);
  }
  await removePageArtifacts(locator.workId, locator.chapterId, pageId);

  return hydrateChapter(chapter);
}

export async function markChapterPagesRunningUnlocked(chapterId: string, pageIds: string[]): Promise<ChapterSnapshot> {
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
          updatedAt: now
        }
      : page
  );
  chapter.status = resolveChapterStatus(chapter.pages);
  chapter.updatedAt = now;
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
  return hydrateChapter(chapter);
}

export async function updatePageAfterAnalysisUnlocked(chapterId: string, page: MangaPage, warnings: string[], status: "completed" | "failed"): Promise<void> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    return;
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    return;
  }

  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((record) =>
    record.id === page.id
      ? {
          ...record,
          blocks: page.blocks,
          analysisStatus: status,
          lastError: status === "failed" ? warnings[warnings.length - 1] : undefined,
          updatedAt: now
        }
      : record
  );
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
}

export async function finalizeRunningPagesUnlocked(
  chapterId: string,
  pageIds: string[],
  status: "idle" | "failed",
  errorMessage?: string
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
          updatedAt: now
        }
      : page
  );
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
}

export async function updatePagesAfterAnalysisUnlocked(chapterId: string, pages: MangaPage[]): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }

  const pageMap = new Map(pages.map((page) => [page.id, page]));
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((record) => {
    const next = pageMap.get(record.id);
    if (!next) {
      return record;
    }
    return {
      ...record,
      blocks: next.blocks,
      analysisStatus: next.analysisStatus,
      lastError: next.lastError,
      updatedAt: now
    };
  });
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
  return hydrateChapter(chapter);
}

export async function updatePagesAfterInpaintingUnlocked(
  chapterId: string,
  pages: MangaPage[],
  cleanupOptions: InpaintingArtifactCleanupOptions = {}
): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }

  const chapterDir = resolve(join(WORKS_ROOT, locator.workId, "chapters", locator.chapterId));
  const replacedInpaintedPaths: string[] = [];
  const pageMap = new Map(pages.map((page) => [page.id, page]));
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((record) => {
    const next = pageMap.get(record.id);
    if (!next) {
      return record;
    }
    const resolvedInpaintedPath = next.inpaintedImagePath
      ? assertChapterImagePath(locator.workId, locator.chapterId, next.inpaintedImagePath, "인페인팅 결과 이미지 경로가 올바르지 않습니다.")
      : undefined;
    if (record.inpaintedImagePath && inpaintedPathChanged(record.inpaintedImagePath, resolvedInpaintedPath)) {
      replacedInpaintedPaths.push(record.inpaintedImagePath);
    }
    return {
      ...record,
      inpaintedImagePath: resolvedInpaintedPath,
      updatedAt: now
    };
  });
  chapter.updatedAt = now;
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
  await cleanupInpaintedArtifacts(chapterDir, replacedInpaintedPaths, chapter.pages, cleanupOptions);
  return hydrateChapter(chapter);
}

export async function setPageInpaintingResultUnlocked(
  chapterId: string,
  pageId: string,
  inpaintedImagePath?: string | null,
  cleanupOptions: InpaintingArtifactCleanupOptions = {}
): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }
  if (!chapter.pages.some((page) => page.id === pageId)) {
    throw new Error("인페인팅 결과를 적용할 페이지를 찾지 못했습니다.");
  }

  const target = chapter.pages.find((page) => page.id === pageId);
  const resolvedInpaintedPath = inpaintedImagePath
    ? assertChapterImagePath(locator.workId, locator.chapterId, inpaintedImagePath, "인페인팅 결과 이미지 경로가 올바르지 않습니다.")
    : undefined;
  const replacedInpaintedPaths =
    target?.inpaintedImagePath && inpaintedPathChanged(target.inpaintedImagePath, resolvedInpaintedPath)
      ? [target.inpaintedImagePath]
      : [];
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((page) =>
    page.id === pageId
      ? {
          ...page,
          inpaintedImagePath: resolvedInpaintedPath,
          updatedAt: now
        }
      : page
  );
  chapter.updatedAt = now;
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
  await cleanupInpaintedArtifacts(resolve(join(WORKS_ROOT, locator.workId, "chapters", locator.chapterId)), replacedInpaintedPaths, chapter.pages, cleanupOptions);
  return hydrateChapter(chapter);
}

async function cleanupInpaintedArtifacts(
  chapterDir: string,
  replacedInpaintedPaths: string[],
  pages: Array<{ inpaintedImagePath?: string }>,
  cleanupOptions: InpaintingArtifactCleanupOptions
): Promise<void> {
  const retainedInpaintedArtifactPaths = cleanupOptions.retainedInpaintedArtifactPaths ?? [];
  const candidatePaths =
    retainedInpaintedArtifactPaths.length > 0
      ? await collectManagedInpaintedArtifacts(chapterDir)
      : replacedInpaintedPaths;
  await removeUnreferencedInpaintedArtifacts(chapterDir, candidatePaths, pages, retainedInpaintedArtifactPaths);
}
