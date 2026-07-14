import { join, resolve } from "node:path";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { hydrateChapter } from "./chapterSnapshots";
import {
  collectManagedInpaintedArtifacts,
  inpaintedPathChanged,
  removeUnreferencedInpaintedArtifacts,
} from "./inpaintedArtifacts";
import {
  WORKS_ROOT,
  assertChapterImagePath,
  findChapterLocation,
  readChapterFile,
  touchWork,
  writeChapterFile,
} from "./libraryFiles";
import { logLibraryWarning } from "./libraryLogger";

export type InpaintingArtifactCleanupOptions = {
  retainedInpaintedArtifactPaths?: string[];
};

export async function updatePagesAfterInpaintingUnlocked(
  chapterId: string,
  pages: MangaPage[],
  cleanupOptions: InpaintingArtifactCleanupOptions = {},
): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("화를 찾지 못했습니다.");
  }

  const chapterDir = resolve(
    join(WORKS_ROOT, locator.workId, "chapters", locator.chapterId),
  );
  const replacedInpaintedPaths: string[] = [];
  const pageMap = new Map(pages.map((page) => [page.id, page]));
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((record) => {
    const next = pageMap.get(record.id);
    if (!next) {
      return record;
    }
    const resolvedInpaintedPath = next.inpaintedImagePath
      ? assertChapterImagePath(
          locator.workId,
          locator.chapterId,
          next.inpaintedImagePath,
          "인페인팅 결과 이미지 경로가 올바르지 않습니다.",
        )
      : undefined;
    if (
      record.inpaintedImagePath &&
      inpaintedPathChanged(record.inpaintedImagePath, resolvedInpaintedPath)
    ) {
      replacedInpaintedPaths.push(record.inpaintedImagePath);
    }
    return {
      ...record,
      inpaintedImagePath: resolvedInpaintedPath,
    };
  });
  chapter.updatedAt = now;
  const savedChapter = hydrateChapter(chapter);
  await writeChapterFile(chapter);
  await finishCommittedInpaintingMutation({
    chapterDir,
    chapterId,
    cleanupOptions,
    pages: chapter.pages,
    replacedInpaintedPaths,
    touch: () => touchWork(locator.workId, now),
  });
  return savedChapter;
}

export async function setPageInpaintingResultUnlocked(
  chapterId: string,
  pageId: string,
  inpaintedImagePath?: string | null,
  cleanupOptions: InpaintingArtifactCleanupOptions = {},
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
    ? assertChapterImagePath(
        locator.workId,
        locator.chapterId,
        inpaintedImagePath,
        "인페인팅 결과 이미지 경로가 올바르지 않습니다.",
      )
    : undefined;
  const replacedInpaintedPaths =
    target?.inpaintedImagePath &&
    inpaintedPathChanged(target.inpaintedImagePath, resolvedInpaintedPath)
      ? [target.inpaintedImagePath]
      : [];
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((page) =>
    page.id === pageId
      ? {
          ...page,
          inpaintedImagePath: resolvedInpaintedPath,
        }
      : page,
  );
  chapter.updatedAt = now;
  const savedChapter = hydrateChapter(chapter);
  await writeChapterFile(chapter);
  await finishCommittedInpaintingMutation({
    chapterDir: resolve(
      join(WORKS_ROOT, locator.workId, "chapters", locator.chapterId),
    ),
    chapterId,
    cleanupOptions,
    pages: chapter.pages,
    replacedInpaintedPaths,
    touch: () => touchWork(locator.workId, now),
  });
  return savedChapter;
}

/**
 * The chapter file is the commit point for an inpainting image mutation.
 * Metadata touching and artifact GC happen afterwards and must never turn an
 * already committed image path into an apparent failure: callers would then
 * discard the exact history transaction needed to undo that committed path.
 */
async function finishCommittedInpaintingMutation({
  chapterDir,
  chapterId,
  cleanupOptions,
  pages,
  replacedInpaintedPaths,
  touch,
}: {
  chapterDir: string;
  chapterId: string;
  cleanupOptions: InpaintingArtifactCleanupOptions;
  pages: Array<{ inpaintedImagePath?: string }>;
  replacedInpaintedPaths: string[];
  touch: () => Promise<void>;
}): Promise<void> {
  try {
    await touch();
  } catch (error) {
    logLibraryWarning(
      "Failed to touch work after committing inpainting paths",
      {
        chapterId,
        error,
      },
    );
  }

  try {
    await cleanupInpaintedArtifacts(
      chapterDir,
      replacedInpaintedPaths,
      pages,
      cleanupOptions,
    );
  } catch (error) {
    logLibraryWarning(
      "Failed to clean artifacts after committing inpainting paths",
      {
        chapterId,
        error,
      },
    );
  }
}

async function cleanupInpaintedArtifacts(
  chapterDir: string,
  replacedInpaintedPaths: string[],
  pages: Array<{ inpaintedImagePath?: string }>,
  cleanupOptions: InpaintingArtifactCleanupOptions,
): Promise<void> {
  const retainedInpaintedArtifactPaths =
    cleanupOptions.retainedInpaintedArtifactPaths ?? [];
  const candidatePaths =
    retainedInpaintedArtifactPaths.length > 0
      ? await collectManagedInpaintedArtifacts(chapterDir)
      : replacedInpaintedPaths;
  await removeUnreferencedInpaintedArtifacts(
    chapterDir,
    candidatePaths,
    pages,
    retainedInpaintedArtifactPaths,
  );
}
