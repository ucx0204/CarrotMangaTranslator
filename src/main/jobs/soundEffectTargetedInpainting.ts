import type { MangaPage } from "../../shared/libraryTypes";
import { normalizeTranslationCompletionReferences } from "../translationCompletionReferences";
import { getAppPaths } from "../appPaths";
import { inpaintPatternPage } from "../inpainting";
import { acquireInpaintingEngine } from "../inpainting/inpaintingEnginePool";
import { resolveEligiblePatternBlocks } from "../inpainting/patternBlockEligibility";
import { openChapter, updatePagesAfterInpainting } from "../library";
import { getAppSettings } from "../settingsStore";
import type { ImageDecodeFallback } from "../regionCrop";
import { throwIfAborted } from "../pipeline/failure";
import { createProductionBubbleLayoutRunner } from "../bubbleLayout/bubbleLayoutFacade";
import { applyInpaintingLayoutStates } from "../inpainting/inpaintingLayoutState";
import { runBubbleLayoutMaskPrepass } from "./bubbleLayoutJob";

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
  createBubbleLayoutRunner: typeof createProductionBubbleLayoutRunner;
};

const productionDependencies: SoundEffectInpaintingDependencies = {
  getAppPaths,
  getAppSettings,
  acquireEngine: acquireInpaintingEngine,
  openChapter,
  inpaintPage: inpaintPatternPage,
  updatePages: updatePagesAfterInpainting,
  createBubbleLayoutRunner: createProductionBubbleLayoutRunner,
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
  const chapter = await openChapterForInpainting(
    chapterId,
    dependencies,
    signal,
  );
  if ("warning" in chapter)
    return { changedPageIds: [], warnings: [chapter.warning] };
  const targetIds = new Set(createdBlocksByPage.map((target) => target.pageId));
  const prepared = await prepareInpaintingEngine(
    dependencies,
    signal,
    decodeFallback,
    chapter.value.pages.filter((page) => targetIds.has(page.id)),
  );
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
      pages: new Map(chapter.value.pages.map((page) => [page.id, page])),
      runner: prepared.runner,
      signal,
    });
  } finally {
    try {
      await prepared.lease.release();
    } finally {
      await prepared.runner?.dispose?.();
    }
  }
}

async function prepareInpaintingEngine(
  dependencies: SoundEffectInpaintingDependencies,
  signal: AbortSignal,
  decodeFallback: ImageDecodeFallback,
  pages: readonly MangaPage[],
): Promise<
  | {
      lease: InpaintingEngineLease;
      runner?: ReturnType<typeof createProductionBubbleLayoutRunner>;
    }
  | { warning: string }
> {
  let runner: ReturnType<typeof createProductionBubbleLayoutRunner> | undefined;
  try {
    const paths = dependencies.getAppPaths();
    const settings = await dependencies.getAppSettings(paths);
    const inpainting = settings.inpainting ?? {};
    if ((inpainting.model ?? "flux-klein") === "flux-klein") {
      runner = dependencies.createBubbleLayoutRunner({
        dataRoot: paths.dataRoot,
        decodeFallback,
        directMl: {
          ...settings.hardware,
          computeGpuBackend: settings.ocr.gpuBackend,
        },
      });
      await runner.preparePages?.(pages, signal);
    }
    const lease = await dependencies.acquireEngine({
      appPaths: paths,
      model: inpainting.model ?? "flux-klein",
      fluxBackend: inpainting.fluxBackend,
      fluxMode: inpainting.fluxMode,
      koharuBackend: inpainting.koharuBackend,
      computeGpuIndex: settings.hardware?.computeGpuIndex,
      allowUnsafeLowMemoryFlux: inpainting.allowUnsafeLowMemoryFlux ?? false,
      signal,
    });
    return { lease, runner };
  } catch (error) {
    await runner?.dispose?.();
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
  pages,
  runner,
  signal,
}: {
  chapterId: string;
  createdBlocksByPage: readonly { pageId: string; blockIds: string[] }[];
  decodeFallback: ImageDecodeFallback;
  dependencies: SoundEffectInpaintingDependencies;
  engineLease: InpaintingEngineLease;
  pages: ReadonlyMap<string, MangaPage>;
  runner?: ReturnType<typeof createProductionBubbleLayoutRunner>;
  signal: AbortSignal;
}): Promise<TargetedSoundEffectInpaintingResult> {
  const outcomes: PageInpaintingOutcome[] = [];
  for (const target of createdBlocksByPage) {
    throwIfAborted(signal);
    outcomes.push(
      await inpaintPageTarget({
        decodeFallback,
        dependencies,
        engineLease,
        page: pages.get(target.pageId),
        runner: engineLease.engine.model === "flux-klein" ? runner : undefined,
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
  runner,
  signal,
  target,
}: {
  decodeFallback: ImageDecodeFallback;
  dependencies: SoundEffectInpaintingDependencies;
  engineLease: InpaintingEngineLease;
  page: MangaPage | undefined;
  runner?: ReturnType<typeof createProductionBubbleLayoutRunner>;
  signal: AbortSignal;
  target: { pageId: string; blockIds: string[] };
}): Promise<PageInpaintingOutcome> {
  if (!page)
    return {
      warnings: [`${target.pageId}: 인페인팅 대상 페이지를 찾지 못했습니다.`],
    };
  const existingIds = new Set(page.blocks.map((block) => block.id));
  const requestedIds = [...new Set(target.blockIds)];
  const selectedIds = requestedIds.filter((id) => existingIds.has(id));
  const warnings = requestedIds
    .filter((blockId) => !existingIds.has(blockId))
    .map(
      (blockId) =>
        `${page.name}: 효과음 ${blockId} 번역 블록을 찾지 못해 원문을 유지했습니다.`,
    );
  if (selectedIds.length === 0) return { warnings };
  try {
    const prepared = runner
      ? await runBubbleLayoutMaskPrepass({
          blockIds: selectedIds,
          config: { policy: "balanced", overwriteManual: false },
          page,
          runner,
          signal,
        })
      : undefined;
    const {
      page: maskPage = page,
      restoreLayout,
      ...maskOptions
    } = prepared ?? {};
    const result = await dependencies.inpaintPage(maskPage, {
      ...maskOptions,
      blockIds: selectedIds,
      signal,
      decodeFallback,
      inpaintingEngine: engineLease.engine,
      preserveExistingInpainting: true,
    });
    const erased = new Set(result.erasedBlockIds ?? []);
    warnings.push(
      ...buildIncompleteInpaintingWarnings(page, selectedIds, erased),
    );
    if (erased.size === 0) return { warnings };
    return {
      page: mergeTargetedInpaintingCompletion(
        restoreLayout
          ? applyInpaintingLayoutStates(result.page, restoreLayout)
          : result.page,
        erased,
      ),
      warnings,
    };
  } catch (error) {
    throwIfAborted(signal);
    warnings.push(
      `${page.name}: 효과음 통합 인페인팅 실패. 번역 블록은 유지했습니다: ${messageOf(error)}`,
    );
    return { warnings };
  }
}

function mergeTargetedInpaintingCompletion(
  page: MangaPage,
  erased: ReadonlySet<string>,
): MangaPage {
  const current = normalizeTranslationCompletionReferences(
    page.translationCompletion,
    page.blocks,
  );
  if (!current) return page;
  const erasedBlockIds = [
    ...new Set([...(current.erasedBlockIds ?? []), ...erased]),
  ];
  const erasedSet = new Set(erasedBlockIds);
  const allEligibleErased = resolveEligiblePatternBlocks(page).every((block) =>
    erasedSet.has(block.id),
  );
  return {
    ...page,
    translationCompletion: {
      workflow: current.workflow,
      status: allEligibleErased ? "completed" : "pending",
      ...(erasedBlockIds.length > 0 ? { erasedBlockIds } : {}),
    },
  };
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
