import { join, resolve } from "node:path";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { hydrateChapter } from "./chapterSnapshots";
import {
  collectManagedInpaintedArtifacts,
  inpaintedPathChanged,
  removeUnreferencedInpaintedArtifacts,
} from "./inpaintedArtifacts";
import {
  assertChapterImagePath,
  findChapterLocation,
  readChapterFile,
  touchWork,
  writeChapterFile,
} from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import { logLibraryWarning } from "./libraryLogger";
import {
  applyInpaintingLayoutStates,
  pageMatchesInpaintingLayoutStates,
  type InpaintingPageLayoutPatch,
} from "../inpainting/inpaintingLayoutState";

export type InpaintingArtifactCleanupOptions = {
  retainedInpaintedArtifactPaths?: string[];
  /**
   * Explicit render-only block updates committed with the image path.
   * The source `bbox` and all translation/format fields remain authoritative
   * from the chapter file and are never copied from the long-running job page.
   */
  layoutPatches?: InpaintingPageLayoutPatch[];
};

export type InpaintingMutationMaintenance = {
  collectManagedArtifacts: typeof collectManagedInpaintedArtifacts;
  removeUnreferencedArtifacts: typeof removeUnreferencedInpaintedArtifacts;
  touchWork: typeof touchWork;
  warn: typeof logLibraryWarning;
};

const productionMaintenance: InpaintingMutationMaintenance = {
  collectManagedArtifacts: collectManagedInpaintedArtifacts,
  removeUnreferencedArtifacts: removeUnreferencedInpaintedArtifacts,
  touchWork,
  warn: logLibraryWarning,
};

export function createInpaintingMutationOperations(
  maintenance: InpaintingMutationMaintenance,
) {
  return {
    updatePagesAfterInpaintingUnlocked: (
      chapterId: string,
      pages: MangaPage[],
      cleanupOptions: InpaintingArtifactCleanupOptions = {},
    ) =>
      updatePagesAfterInpaintingWithMaintenance(
        chapterId,
        pages,
        cleanupOptions,
        maintenance,
      ),
    setPageInpaintingResultUnlocked: (
      chapterId: string,
      pageId: string,
      inpaintedImagePath?: string | null,
      cleanupOptions: InpaintingArtifactCleanupOptions = {},
    ) =>
      setPageInpaintingResultWithMaintenance(
        chapterId,
        pageId,
        inpaintedImagePath,
        cleanupOptions,
        maintenance,
      ),
  };
}

const productionOperations = createInpaintingMutationOperations(
  productionMaintenance,
);

export const updatePagesAfterInpaintingUnlocked =
  productionOperations.updatePagesAfterInpaintingUnlocked;
export const setPageInpaintingResultUnlocked =
  productionOperations.setPageInpaintingResultUnlocked;

async function updatePagesAfterInpaintingWithMaintenance(
  chapterId: string,
  pages: MangaPage[],
  cleanupOptions: InpaintingArtifactCleanupOptions,
  maintenance: InpaintingMutationMaintenance,
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
    join(getWorksRoot(), locator.workId, "chapters", locator.chapterId),
  );
  const replacedInpaintedPaths: string[] = [];
  const pageMap = new Map(pages.map((page) => [page.id, page]));
  const layoutPatchMap = resolveLayoutPatchMap(cleanupOptions.layoutPatches, [
    ...pageMap.keys(),
  ]);
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
    const layoutPatch = layoutPatchMap.get(record.id);
    if (
      layoutPatch?.expectedStates &&
      !pageMatchesInpaintingLayoutStates(record, layoutPatch.expectedStates)
    ) {
      throw new Error(
        "페이지의 텍스트 배치가 다른 작업으로 변경되어 인페인팅 결과를 저장할 수 없습니다.",
      );
    }
    const withLayout = layoutPatch
      ? applyInpaintingLayoutStates(record, layoutPatch.states)
      : record;
    return {
      ...withLayout,
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
    touch: () => maintenance.touchWork(locator.workId, now),
    maintenance,
  });
  return savedChapter;
}

function resolveLayoutPatchMap(
  patches: readonly InpaintingPageLayoutPatch[] | undefined,
  knownPageIds: readonly string[],
): Map<string, InpaintingPageLayoutPatch> {
  const known = new Set(knownPageIds);
  const patchMap = new Map<string, InpaintingPageLayoutPatch>();
  for (const patch of patches ?? []) {
    if (!known.has(patch.pageId)) {
      throw new Error("말풍선 배치를 적용할 페이지를 찾지 못했습니다.");
    }
    if (patchMap.has(patch.pageId)) {
      throw new Error("같은 페이지의 말풍선 배치가 중복되었습니다.");
    }
    patchMap.set(patch.pageId, patch);
  }
  return patchMap;
}

async function setPageInpaintingResultWithMaintenance(
  chapterId: string,
  pageId: string,
  inpaintedImagePath: string | null | undefined,
  cleanupOptions: InpaintingArtifactCleanupOptions,
  maintenance: InpaintingMutationMaintenance,
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
      join(getWorksRoot(), locator.workId, "chapters", locator.chapterId),
    ),
    chapterId,
    cleanupOptions,
    pages: chapter.pages,
    replacedInpaintedPaths,
    touch: () => maintenance.touchWork(locator.workId, now),
    maintenance,
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
  maintenance,
}: {
  chapterDir: string;
  chapterId: string;
  cleanupOptions: InpaintingArtifactCleanupOptions;
  pages: Array<{ inpaintedImagePath?: string }>;
  replacedInpaintedPaths: string[];
  touch: () => Promise<void>;
  maintenance: InpaintingMutationMaintenance;
}): Promise<void> {
  try {
    await touch();
  } catch (error) {
    maintenance.warn("Failed to touch work after committing inpainting paths", {
      chapterId,
      error,
    });
  }

  try {
    await cleanupInpaintedArtifacts(
      chapterDir,
      replacedInpaintedPaths,
      pages,
      cleanupOptions,
      maintenance,
    );
  } catch (error) {
    maintenance.warn(
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
  maintenance: InpaintingMutationMaintenance,
): Promise<void> {
  const retainedInpaintedArtifactPaths =
    cleanupOptions.retainedInpaintedArtifactPaths ?? [];
  const candidatePaths =
    retainedInpaintedArtifactPaths.length > 0
      ? await maintenance.collectManagedArtifacts(chapterDir)
      : replacedInpaintedPaths;
  await maintenance.removeUnreferencedArtifacts(
    chapterDir,
    candidatePaths,
    pages,
    retainedInpaintedArtifactPaths,
  );
}
