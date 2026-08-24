/* eslint-disable max-lines -- inpainting image, mask, layout, and cleanup updates are one atomic library mutation boundary */
import { join, resolve } from "node:path";
import type {
  ChapterSnapshot,
  LibraryChapter,
  MangaPage,
} from "../../shared/libraryTypes";
import {
  createPageRevision,
  type PageJobTargetSnapshot,
  type PageRevision,
} from "../../shared/pageRevision";
import { hydrateChapter } from "./chapterSnapshots";
import { resolveChapterStatus } from "./chapterRecords";
import {
  collectManagedInpaintMaskArtifacts,
  collectManagedInpaintedArtifacts,
  inpaintedPathChanged,
  removeUnreferencedInpaintMaskArtifacts,
  removeUnreferencedInpaintedArtifacts,
} from "./inpaintedArtifacts";
import {
  assertChapterImagePath,
  findChapterLocation,
  readChapterFile,
  readWorkFile,
} from "./libraryFiles";
import { runLibraryTransaction } from "./libraryTransaction";
import { stageChapterFile, stageWorkFile } from "./libraryTransactionFiles";
import { getWorksRoot } from "./libraryPaths";
import { logLibraryWarning } from "./libraryLogger";
import {
  applyInpaintingLayoutStates,
  pageMatchesInpaintingLayoutStates,
  type InpaintingPageLayoutPatch,
} from "../inpainting/inpaintingLayoutState";

export type InpaintingArtifactCleanupOptions = {
  expectedTargets?: PageJobTargetSnapshot[];
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
  collectManagedMaskArtifacts?: typeof collectManagedInpaintMaskArtifacts;
  removeUnreferencedArtifacts: typeof removeUnreferencedInpaintedArtifacts;
  removeUnreferencedMaskArtifacts?: typeof removeUnreferencedInpaintMaskArtifacts;
  warn: typeof logLibraryWarning;
};

const productionMaintenance: InpaintingMutationMaintenance = {
  collectManagedArtifacts: collectManagedInpaintedArtifacts,
  collectManagedMaskArtifacts: collectManagedInpaintMaskArtifacts,
  removeUnreferencedArtifacts: removeUnreferencedInpaintedArtifacts,
  removeUnreferencedMaskArtifacts: removeUnreferencedInpaintMaskArtifacts,
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
  const replacedMaskPaths: string[] = [];
  assertRequestedInpaintingPagesExist(chapter.pages, pages);
  const pageMap = new Map(pages.map((page) => [page.id, page]));
  const expectedRevisionMap = resolveExpectedRevisionMap(
    chapterId,
    cleanupOptions.expectedTargets,
    [...pageMap.keys()],
  );
  const layoutPatchMap = resolveLayoutPatchMap(cleanupOptions.layoutPatches, [
    ...pageMap.keys(),
  ]);
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((record) =>
    applyInpaintingPageUpdate(record, {
      expectedRevisionMap,
      layoutPatchMap,
      next: pageMap.get(record.id),
      now,
      replacedInpaintedPaths,
      replacedMaskPaths,
      workId: locator.workId,
      chapterId: locator.chapterId,
    }),
  );
  chapter.status = resolveChapterStatus(chapter.pages);
  chapter.updatedAt = now;
  const savedChapter = hydrateChapter(chapter);
  const work = await readWorkFile(locator.workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  await runLibraryTransaction(
    "update-pages-after-inpainting",
    async (transaction) => {
      await stageChapterFile(transaction, chapter);
      await stageWorkFile(transaction, { ...work, updatedAt: now });
    },
  );
  await finishCommittedInpaintingMutation({
    chapterDir,
    chapterId,
    cleanupOptions,
    pages: chapter.pages,
    replacedInpaintedPaths,
    replacedMaskPaths,
    maintenance,
  });
  return savedChapter;
}

function applyInpaintingPageUpdate(
  record: LibraryChapter["pages"][number],
  context: {
    chapterId: string;
    expectedRevisionMap: ReadonlyMap<string, PageRevision>;
    layoutPatchMap: ReadonlyMap<string, InpaintingPageLayoutPatch>;
    next?: MangaPage;
    now: string;
    replacedInpaintedPaths: string[];
    replacedMaskPaths: string[];
    workId: string;
  },
): LibraryChapter["pages"][number] {
  const { next } = context;
  if (!next) return record;
  assertExpectedPageRevision(
    record,
    context.expectedRevisionMap.get(record.id),
  );
  const paths = resolveNextArtifactPaths(
    context.workId,
    context.chapterId,
    next,
  );
  collectReplacedArtifactPaths(record, paths, context);
  const withLayout = applyCheckedLayout(
    record,
    context.layoutPatchMap.get(record.id),
  );
  return {
    ...withLayout,
    inpaintedImagePath: paths.inpainted,
    inpaintMaskPath: paths.mask,
    maskProvenance: paths.mask ? next.maskProvenance : undefined,
    ...copyTranslationCompletionProperty(next),
    updatedAt: context.now,
  };
}

function resolveNextArtifactPaths(
  workId: string,
  chapterId: string,
  next: MangaPage,
): { inpainted?: string; mask?: string } {
  const inpainted = next.inpaintedImagePath
    ? assertChapterImagePath(
        workId,
        chapterId,
        next.inpaintedImagePath,
        "인페인팅 결과 이미지 경로가 올바르지 않습니다.",
      )
    : undefined;
  const mask =
    inpainted && next.inpaintMaskPath
      ? assertChapterImagePath(
          workId,
          chapterId,
          next.inpaintMaskPath,
          "인페인팅 마스크 경로가 올바르지 않습니다.",
        )
      : undefined;
  return { inpainted, mask };
}

function collectReplacedArtifactPaths(
  record: LibraryChapter["pages"][number],
  paths: { inpainted?: string; mask?: string },
  context: { replacedInpaintedPaths: string[]; replacedMaskPaths: string[] },
): void {
  if (
    record.inpaintedImagePath &&
    inpaintedPathChanged(record.inpaintedImagePath, paths.inpainted)
  ) {
    context.replacedInpaintedPaths.push(record.inpaintedImagePath);
  }
  if (
    record.inpaintMaskPath &&
    inpaintedPathChanged(record.inpaintMaskPath, paths.mask)
  ) {
    context.replacedMaskPaths.push(record.inpaintMaskPath);
  }
}

function assertExpectedPageRevision(
  record: LibraryChapter["pages"][number],
  expectedRevision: PageRevision | undefined,
): void {
  if (expectedRevision && createPageRevision(record) !== expectedRevision) {
    throw new Error(
      "페이지가 편집되어 오래된 인페인팅 결과를 적용하지 않았습니다.",
    );
  }
}

function applyCheckedLayout(
  record: LibraryChapter["pages"][number],
  layoutPatch: InpaintingPageLayoutPatch | undefined,
): LibraryChapter["pages"][number] {
  if (
    layoutPatch?.expectedStates &&
    !pageMatchesInpaintingLayoutStates(record, layoutPatch.expectedStates)
  ) {
    throw new Error(
      "페이지의 텍스트 배치가 다른 작업으로 변경되어 인페인팅 결과를 저장할 수 없습니다.",
    );
  }
  return layoutPatch
    ? applyInpaintingLayoutStates(record, layoutPatch.states)
    : record;
}

function resolveExpectedRevisionMap(
  chapterId: string,
  targets: readonly PageJobTargetSnapshot[] | undefined,
  knownPageIds: readonly string[],
): Map<string, PageJobTargetSnapshot["revision"]> {
  const known = new Set(knownPageIds);
  const revisions = new Map<string, PageJobTargetSnapshot["revision"]>();
  for (const target of targets ?? []) {
    if (target.chapterId !== chapterId || !known.has(target.pageId)) {
      throw new Error("인페인팅 작업 대상이 현재 화와 일치하지 않습니다.");
    }
    if (revisions.has(target.pageId)) {
      throw new Error("인페인팅 작업 대상이 중복되었습니다.");
    }
    revisions.set(target.pageId, target.revision);
  }
  return revisions;
}

function copyTranslationCompletionProperty(
  page: MangaPage,
): Pick<MangaPage, "translationCompletion"> | Record<never, never> {
  if (!Object.hasOwn(page, "translationCompletion")) {
    return {};
  }
  return {
    translationCompletion: page.translationCompletion
      ? {
          ...page.translationCompletion,
          ...(page.translationCompletion.erasedBlockIds
            ? {
                erasedBlockIds: [...page.translationCompletion.erasedBlockIds],
              }
            : {}),
        }
      : undefined,
  };
}

function assertRequestedInpaintingPagesExist(
  storedPages: ReadonlyArray<Pick<MangaPage, "id">>,
  requestedPages: readonly MangaPage[],
): void {
  const knownPageIds = new Set(storedPages.map((page) => page.id));
  const requestedPageIds = new Set<string>();
  for (const page of requestedPages) {
    if (requestedPageIds.has(page.id)) {
      throw new Error("같은 페이지의 인페인팅 결과가 중복되었습니다.");
    }
    requestedPageIds.add(page.id);
    if (!knownPageIds.has(page.id)) {
      throw new Error("인페인팅 결과를 적용할 페이지를 찾지 못했습니다.");
    }
  }
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
  const replacedMaskPaths = target?.inpaintMaskPath
    ? [target.inpaintMaskPath]
    : [];
  const now = new Date().toISOString();
  chapter.pages = chapter.pages.map((page) =>
    page.id === pageId
      ? {
          ...page,
          inpaintedImagePath: resolvedInpaintedPath,
          inpaintMaskPath: undefined,
          maskProvenance: undefined,
          updatedAt: now,
        }
      : page,
  );
  chapter.updatedAt = now;
  const savedChapter = hydrateChapter(chapter);
  const work = await readWorkFile(locator.workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  await runLibraryTransaction(
    "set-page-inpainting-result",
    async (transaction) => {
      await stageChapterFile(transaction, chapter);
      await stageWorkFile(transaction, { ...work, updatedAt: now });
    },
  );
  await finishCommittedInpaintingMutation({
    chapterDir: resolve(
      join(getWorksRoot(), locator.workId, "chapters", locator.chapterId),
    ),
    chapterId,
    cleanupOptions,
    pages: chapter.pages,
    replacedInpaintedPaths,
    replacedMaskPaths,
    maintenance,
  });
  return savedChapter;
}

/**
 * Chapter/work metadata are committed together by the durable library
 * transaction. Artifact GC happens afterwards and must never turn an already
 * committed image path into an apparent failure: callers would then discard
 * the exact history transaction needed to undo that committed path.
 */
async function finishCommittedInpaintingMutation({
  chapterDir,
  chapterId,
  cleanupOptions,
  pages,
  replacedInpaintedPaths,
  replacedMaskPaths,
  maintenance,
}: {
  chapterDir: string;
  chapterId: string;
  cleanupOptions: InpaintingArtifactCleanupOptions;
  pages: Array<{ inpaintedImagePath?: string; inpaintMaskPath?: string }>;
  replacedInpaintedPaths: string[];
  replacedMaskPaths: string[];
  maintenance: InpaintingMutationMaintenance;
}): Promise<void> {
  try {
    await cleanupInpaintedArtifacts(
      chapterDir,
      replacedInpaintedPaths,
      replacedMaskPaths,
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
  replacedMaskPaths: string[],
  pages: Array<{ inpaintedImagePath?: string; inpaintMaskPath?: string }>,
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
  const maskCandidates =
    retainedInpaintedArtifactPaths.length > 0 &&
    maintenance.collectManagedMaskArtifacts
      ? await maintenance.collectManagedMaskArtifacts(chapterDir)
      : replacedMaskPaths;
  await maintenance.removeUnreferencedMaskArtifacts?.(
    chapterDir,
    maskCandidates,
    pages,
    retainedInpaintedArtifactPaths,
  );
}
