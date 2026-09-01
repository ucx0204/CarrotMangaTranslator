import type { MangaPage } from "../../shared/libraryTypes";
import { getAppPaths } from "../appPaths";
import { inpaintPatternPage } from "../inpainting";
import { acquireInpaintingEngine } from "../inpainting/inpaintingEnginePool";
import { openChapter, updatePagesAfterInpainting } from "../library";
import { getAppSettings } from "../settingsStore";
import type { ImageDecodeFallback } from "../regionCrop";
import { throwIfAborted } from "../pipeline/failure";

export type TargetedSoundEffectInpaintingResult = {
  changedPageIds: string[];
  warnings: string[];
};

export type SoundEffectInpaintingDependencies = {
  getAppPaths: typeof getAppPaths;
  getAppSettings: typeof getAppSettings;
  acquireEngine: typeof acquireInpaintingEngine;
  openChapter: typeof openChapter;
  inpaintPage: typeof inpaintPatternPage;
  updatePages: typeof updatePagesAfterInpainting;
};

const productionDependencies: SoundEffectInpaintingDependencies = {
  getAppPaths,
  getAppSettings,
  acquireEngine: acquireInpaintingEngine,
  openChapter,
  inpaintPage: inpaintPatternPage,
  updatePages: updatePagesAfterInpainting,
};

type InpaintingEngineLease = Awaited<
  ReturnType<SoundEffectInpaintingDependencies["acquireEngine"]>
>;

type PageInpaintingOutcome = {
  page?: MangaPage;
  warnings: string[];
};

/**
 * Inpaint only block ids created by the just-finished SFX translation. Explicit
 * block selection bypasses their automatic-inpainting exclusion without ever
 * making older dialogue blocks eligible.
 */
export async function inpaintCreatedSoundEffectBlocks(
  chapterId: string,
  createdBlocksByPage: readonly { pageId: string; blockIds: string[] }[],
  decodeFallback: ImageDecodeFallback,
  signal: AbortSignal,
  dependencies: SoundEffectInpaintingDependencies = productionDependencies,
): Promise<TargetedSoundEffectInpaintingResult> {
  if (createdBlocksByPage.length === 0) {
    return { changedPageIds: [], warnings: [] };
  }
  const prepared = await prepareInpaintingEngine(dependencies, signal);
  if ("warning" in prepared) {
    return { changedPageIds: [], warnings: [prepared.warning] };
  }
  try {
    return await inpaintChapterTargets({
      chapterId,
      createdBlocksByPage,
      decodeFallback,
      dependencies,
      engineLease: prepared.lease,
      signal,
    });
  } finally {
    prepared.lease.release();
  }
}

async function prepareInpaintingEngine(
  dependencies: SoundEffectInpaintingDependencies,
  signal: AbortSignal,
): Promise<{ lease: InpaintingEngineLease } | { warning: string }> {
  try {
    const paths = dependencies.getAppPaths();
    const settings = await dependencies.getAppSettings(paths);
    const lease = await dependencies.acquireEngine({
      appPaths: paths,
      model: settings.inpainting?.model ?? "flux-klein",
      fluxBackend: settings.inpainting?.fluxBackend,
      koharuBackend: settings.inpainting?.koharuBackend,
      computeGpuIndex: settings.hardware?.computeGpuIndex,
      allowUnsafeLowMemoryFlux:
        settings.inpainting?.allowUnsafeLowMemoryFlux ?? false,
      signal,
    });
    return { lease };
  } catch (error) {
    throwIfAborted(signal);
    return {
      warning: `효과음 번역은 저장했지만 인페인팅 엔진을 준비하지 못했습니다: ${messageOf(error)}`,
    };
  }
}

async function inpaintChapterTargets({
  chapterId,
  createdBlocksByPage,
  decodeFallback,
  dependencies,
  engineLease,
  signal,
}: {
  chapterId: string;
  createdBlocksByPage: readonly { pageId: string; blockIds: string[] }[];
  decodeFallback: ImageDecodeFallback;
  dependencies: SoundEffectInpaintingDependencies;
  engineLease: InpaintingEngineLease;
  signal: AbortSignal;
}): Promise<TargetedSoundEffectInpaintingResult> {
  const chapter = await openChapterForInpainting(
    chapterId,
    dependencies,
    signal,
  );
  if ("warning" in chapter) {
    return { changedPageIds: [], warnings: [chapter.warning] };
  }
  const pages = new Map(chapter.value.pages.map((page) => [page.id, page]));
  const outcomes: PageInpaintingOutcome[] = [];
  for (const target of createdBlocksByPage) {
    throwIfAborted(signal);
    outcomes.push(
      await inpaintPageTarget({
        decodeFallback,
        dependencies,
        engineLease,
        page: pages.get(target.pageId),
        signal,
        target,
      }),
    );
  }
  return persistInpaintedPages(chapterId, outcomes, dependencies, signal);
}

async function openChapterForInpainting(
  chapterId: string,
  dependencies: SoundEffectInpaintingDependencies,
  signal: AbortSignal,
): Promise<
  { value: Awaited<ReturnType<typeof openChapter>> } | { warning: string }
> {
  try {
    return { value: await dependencies.openChapter(chapterId) };
  } catch (error) {
    throwIfAborted(signal);
    return {
      warning: `효과음 번역은 저장했지만 인페인팅 대상 화를 열지 못했습니다: ${messageOf(error)}`,
    };
  }
}

async function inpaintPageTarget({
  decodeFallback,
  dependencies,
  engineLease,
  page,
  signal,
  target,
}: {
  decodeFallback: ImageDecodeFallback;
  dependencies: SoundEffectInpaintingDependencies;
  engineLease: InpaintingEngineLease;
  page: MangaPage | undefined;
  signal: AbortSignal;
  target: { pageId: string; blockIds: string[] };
}): Promise<PageInpaintingOutcome> {
  if (!page) {
    return {
      warnings: [`${target.pageId}: 인페인팅 대상 페이지를 찾지 못했습니다.`],
    };
  }
  const existingIds = new Set(page.blocks.map((block) => block.id));
  const requestedIds = [...new Set(target.blockIds)];
  const selectedIds = requestedIds.filter((blockId) =>
    existingIds.has(blockId),
  );
  const warnings = requestedIds
    .filter((blockId) => !existingIds.has(blockId))
    .map(
      (blockId) =>
        `${page.name}: 효과음 ${blockId} 번역 블록을 찾지 못해 원문을 유지했습니다.`,
    );
  if (selectedIds.length === 0) return { warnings };
  try {
    const result = await dependencies.inpaintPage(page, {
      blockIds: selectedIds,
      signal,
      decodeFallback,
      inpaintingEngine: engineLease.engine,
    });
    const erased = new Set(result.erasedBlockIds ?? []);
    warnings.push(
      ...buildIncompleteInpaintingWarnings(page, selectedIds, erased),
    );
    return erased.size > 0 ? { page: result.page, warnings } : { warnings };
  } catch (error) {
    throwIfAborted(signal);
    warnings.push(
      `${page.name}: 효과음 통합 인페인팅 실패. 번역 블록은 유지했습니다: ${messageOf(error)}`,
    );
    return { warnings };
  }
}

function buildIncompleteInpaintingWarnings(
  page: MangaPage,
  selectedIds: readonly string[],
  erased: ReadonlySet<string>,
): string[] {
  return selectedIds
    .filter((blockId) => !erased.has(blockId))
    .map(
      (blockId) =>
        `${page.name}: 효과음 ${blockId} 원문 지우기가 완료되지 않았습니다. 번역 블록은 유지했습니다.`,
    );
}

async function persistInpaintedPages(
  chapterId: string,
  outcomes: readonly PageInpaintingOutcome[],
  dependencies: SoundEffectInpaintingDependencies,
  signal: AbortSignal,
): Promise<TargetedSoundEffectInpaintingResult> {
  const warnings = outcomes.flatMap((outcome) => outcome.warnings);
  const changed = outcomes.flatMap((outcome) =>
    outcome.page ? [outcome.page] : [],
  );
  if (changed.length === 0) return { changedPageIds: [], warnings };
  try {
    await dependencies.updatePages(chapterId, changed);
    return { changedPageIds: changed.map((page) => page.id), warnings };
  } catch (error) {
    throwIfAborted(signal);
    warnings.push(
      `효과음 번역은 유지했지만 인페인팅 결과 저장에 실패했습니다: ${messageOf(error)}`,
    );
    return { changedPageIds: [], warnings };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
