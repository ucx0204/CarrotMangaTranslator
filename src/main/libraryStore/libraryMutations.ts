import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../../shared/libraryTypes";
import type { SavePageBlocksRequest } from "../../shared/shareTypes";
import { hashTranslationBlocks } from "../../shared/blockFingerprint";
import { normalizeBlockType } from "../../shared/geometry";
import { logWarn } from "../logger";
import { hydrateChapter } from "./chapterSnapshots";
import {
  reorderIds,
  reorderRecords,
  resolveChapterStatus,
} from "./chapterRecords";
import { listLibrary } from "./libraryAccess";
import {
  getDefaultWorkTitle,
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
  type ChapterFile,
} from "./libraryFiles";
import { unlinkIfExists } from "./storage";
import { sanitizeTitle } from "./titles";

export { appendAnalyzedPageBlocksUnlocked } from "./libraryAnalysisMutations";
export {
  setPageInpaintingResultUnlocked,
  updatePagesAfterInpaintingUnlocked,
  type InpaintingArtifactCleanupOptions,
} from "./libraryInpaintingMutations";

export type PageAnalysisUpdate = {
  expectedUpdatedAt?: string;
  page: MangaPage;
  warnings: string[];
  status: "completed" | "failed";
};

const ANALYSIS_UPDATE_CONFLICT_MESSAGE =
  "사용자 편집으로 자동 번역 결과를 적용하지 않았습니다.";

export async function savePageBlocksUnlocked(
  request: SavePageBlocksRequest,
): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(request.chapterId);
  if (!locator) {
    throw new Error("저장할 화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("저장할 화를 찾지 못했습니다.");
  }
  const page = chapter.pages.find(
    (candidate) => candidate.id === request.pageId,
  );
  if (!page) {
    throw new Error("저장할 페이지를 찾지 못했습니다.");
  }
  const currentBlocksHash = hashTranslationBlocks(page.blocks);
  if (
    request.baseUpdatedAt &&
    page.updatedAt !== request.baseUpdatedAt &&
    !canRebasePageBlockSave(currentBlocksHash, request)
  ) {
    logWarn("Page block save conflict", {
      chapterId: request.chapterId,
      pageId: request.pageId,
      baseUpdatedAt: request.baseUpdatedAt,
      currentUpdatedAt: page.updatedAt,
      baseBlocksHash: request.baseBlocksHash,
      currentBlocksHash,
      dirtyVersion: request.dirtyVersion,
      saveReason: request.saveReason,
    });
    throw new Error(
      "페이지가 다른 작업으로 갱신되었습니다. 최신 내용을 다시 불러온 뒤 저장해 주세요.",
    );
  }

  const now = new Date().toISOString();
  const pages = chapter.pages.map((candidate) =>
    candidate.id === request.pageId
      ? {
          ...candidate,
          blocks: request.blocks.map((block) => ({
            ...block,
            type: normalizeBlockType(block.type),
          })),
          updatedAt: now,
        }
      : candidate,
  );
  const nextChapter: ChapterFile = {
    ...chapter,
    pages,
    status: resolveChapterStatus(pages),
    updatedAt: now,
  };
  await writeChapterFile(nextChapter);
  await touchWork(locator.workId, now);
  return hydrateChapter(nextChapter);
}

function canRebasePageBlockSave(
  currentBlocksHash: string,
  request: SavePageBlocksRequest,
): boolean {
  return (
    Boolean(request.baseBlocksHash) &&
    currentBlocksHash === request.baseBlocksHash
  );
}

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
  await writeChapterFile(chapter);
  await touchWork(locator.workId, chapter.updatedAt);
  return listLibrary();
}

export async function deleteWorkUnlocked(
  workId: string,
): Promise<LibraryIndex> {
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

  work.chapterOrder = work.chapterOrder.filter((id) => id !== chapter.id);
  work.updatedAt = new Date().toISOString();
  await writeWorkFile(work);
  await removeChapterDirectory(locator.workId, locator.chapterId);

  return listLibrary();
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
  chapter.pageOrder = reorderIds(chapter.pageOrder, pageIds);
  chapter.pages = reorderRecords(chapter.pages, chapter.pageOrder);
  chapter.updatedAt = new Date().toISOString();
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, chapter.updatedAt);
  return hydrateChapter(chapter);
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

  chapter.pageOrder = chapter.pageOrder.filter((id) => id !== pageId);
  chapter.pages = chapter.pages.filter((page) => page.id !== pageId);
  chapter.updatedAt = new Date().toISOString();
  chapter.status = resolveChapterStatus(chapter.pages);

  await writeChapterFile(chapter);
  await touchWork(locator.workId, chapter.updatedAt);
  await unlinkIfExists(target.imagePath);
  if (target.inpaintedImagePath) {
    await unlinkIfExists(target.inpaintedImagePath);
  }
  await removePageArtifacts(locator.workId, locator.chapterId, pageId);

  return hydrateChapter(chapter);
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
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
  return hydrateChapter(chapter);
}

export async function updatePagesAfterAnalysisUnlocked(
  chapterId: string,
  updates: PageAnalysisUpdate[],
): Promise<void> {
  if (updates.length === 0) {
    return;
  }
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    return;
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    return;
  }

  const updatesByPageId = new Map(
    updates.map((update) => [update.page.id, update]),
  );
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((record) => {
    const update = updatesByPageId.get(record.id);
    if (!update) {
      return record;
    }
    if (
      update.expectedUpdatedAt &&
      record.updatedAt !== update.expectedUpdatedAt
    ) {
      return {
        ...record,
        analysisStatus: "failed",
        lastError: ANALYSIS_UPDATE_CONFLICT_MESSAGE,
      };
    }
    if (update.status === "failed") {
      return {
        ...record,
        analysisStatus: "failed",
        lastError: update.warnings[update.warnings.length - 1],
      };
    }
    return {
      ...record,
      blocks: update.page.blocks,
      analysisStatus: "completed",
      lastError: undefined,
      updatedAt: now,
    };
  });
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
}

export async function updatePageAfterAnalysisUnlocked(
  chapterId: string,
  page: MangaPage,
  warnings: string[],
  status: "completed" | "failed",
  expectedUpdatedAt?: string,
): Promise<void> {
  await updatePagesAfterAnalysisUnlocked(chapterId, [
    { page, warnings, status, expectedUpdatedAt },
  ]);
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
  await writeChapterFile(chapter);
  await touchWork(locator.workId, now);
}
