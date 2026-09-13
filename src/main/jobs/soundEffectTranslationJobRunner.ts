import { editSoundEffectPage } from "./soundEffectImageEditing";
import {
  reviewSoundEffectImages,
  type DeferredSoundEffectPage,
} from "./soundEffectTranslationReview";
import { externalImageRegionIsHidden } from "../imageRedactionContext";
import { withImageRedactionReview } from "./imageRedactionReview";
import { prepareSoundEffectTranslationRun } from "./soundEffectTranslationPreparation";
import { editTranslatedPageWithCodex } from "../codexImageEditing";
import type { StartSoundEffectTranslationResult } from "../../shared/analysisTypes";
import {
  appendResolvedSoundEffectBlocks,
  getRunPaths,
  openChapter,
  resolveWorkContextForChapter,
} from "../library";
import { isAbortErrorLike, throwIfAborted } from "../pipeline/failure";
import { createDefaultWholePagePipelineDependencies } from "../pipeline/wholePagePipelinePorts";
import type { SoundEffectTranslationJobInput } from "./translationJobTypes";
import {
  emitSoundEffectPageDone,
  emitSoundEffectPageRunning,
  emitSoundEffectTerminal,
  finishSoundEffectTranslation,
} from "./soundEffectTranslationEvents";
import { buildFontMatchedSoundEffectEntries } from "./soundEffectFontMatching";
import { throwSoundEffectPhaseErrors } from "./soundEffectTranslationResult";
import { maybeInpaintTranslatedSoundEffectBlocks } from "./soundEffectTranslationInpainting";
import { translateStoredSoundEffectRegions } from "./soundEffectTranslationPage";
import { inpaintCreatedSoundEffectBlocks } from "./soundEffectTargetedInpainting";
import {
  countChapterPendingSoundEffectRegions,
  resolveStoredSoundEffectTargets,
} from "./soundEffectTranslationTargets";

export type SoundEffectTranslationJobRunnerDependencies = {
  translateRegions?: typeof translateStoredSoundEffectRegions;
  editImages?: typeof editTranslatedPageWithCodex;
  appendResolvedBlocks: typeof appendResolvedSoundEffectBlocks;
  createPipelineDependencies: typeof createDefaultWholePagePipelineDependencies;
  getRunPaths: typeof getRunPaths;
  openChapter: typeof openChapter;
  resolveWorkContext: typeof resolveWorkContextForChapter;
  inpaintCreatedBlocks: typeof inpaintCreatedSoundEffectBlocks;
};

const productionDependencies: SoundEffectTranslationJobRunnerDependencies = {
  editImages: editTranslatedPageWithCodex,
  appendResolvedBlocks: appendResolvedSoundEffectBlocks,
  createPipelineDependencies: createDefaultWholePagePipelineDependencies,
  getRunPaths,
  openChapter,
  resolveWorkContext: resolveWorkContextForChapter,
  inpaintCreatedBlocks: inpaintCreatedSoundEffectBlocks,
};

export async function runSoundEffectTranslationJob(
  input: SoundEffectTranslationJobInput,
  dependencies: SoundEffectTranslationJobRunnerDependencies = productionDependencies,
): Promise<StartSoundEffectTranslationResult> {
  const run = async () => {
    const pipeline = dependencies.createPipelineDependencies();
    const prepared = await prepareSoundEffectTranslationRun(
      input,
      dependencies,
      pipeline,
      dependencies !== productionDependencies,
    );
    const deferredPages: DeferredSoundEffectPage[] = [];
    let translationError: unknown;
    try {
      await translateSoundEffectTargets(
        input,
        prepared,
        dependencies,
        deferredPages,
      );
    } catch (error) {
      translationError = error;
    } finally {
      await prepared.endpoint.disposeEndpointSession();
    }
    let finalizationError: unknown;
    try {
      await saveDeferredFontMatchedPages(
        input,
        prepared,
        dependencies,
        deferredPages,
      );
    } catch (error) {
      finalizationError = error;
    } finally {
      await prepared.pipelineDependencies.fontMatching.pageInference?.dispose?.();
    }
    throwSoundEffectPhaseErrors(translationError, finalizationError);
    await maybeInpaintTranslatedSoundEffectBlocks({
      ...input,
      request: {
        ...input.request,
        inpaintAfterTranslation:
          !input.request.codexTypesetting &&
          input.request.inpaintAfterTranslation,
      },
      inpaintCreatedBlocks: dependencies.inpaintCreatedBlocks,
      pageTotal: prepared.targets.length,
    });
    input.state.chapter = await dependencies.openChapter(
      input.request.chapterId,
    );
    return finishSoundEffectTranslation(
      input,
      input.state.chapter,
      prepared.requestedRegionCount,
      prepared.targets.length,
    );
  };
  if (dependencies !== productionDependencies) return run();
  const chapter = await dependencies.openChapter(input.request.chapterId);
  input.state.chapter = chapter;
  const targets = resolveStoredSoundEffectTargets(chapter, input.request);
  return withImageRedactionReview(
    {
      jobId: input.id,
      kind: "sound-effect-translation",
      pages: targets.map((target) => target.page),
      signal: input.abortController.signal,
      emit: input.emit,
      imageEdit: Boolean(input.request.codexTypesetting),
    },
    run,
  );
}

async function translateSoundEffectTargets(
  input: SoundEffectTranslationJobInput,
  prepared: Awaited<ReturnType<typeof prepareSoundEffectTranslationRun>>,
  dependencies: SoundEffectTranslationJobRunnerDependencies,
  deferredPages: DeferredSoundEffectPage[],
): Promise<void> {
  const { abortController, context, emit, id, request, state } = input;
  for (const [pageIndex, original] of prepared.targets.entries()) {
    const target = {
      ...original,
      regions: original.regions.filter(
        (region) => !externalImageRegionIsHidden(original.page, region.bbox),
      ),
    };
    const held = original.regions.length - target.regions.length;
    if (held)
      state.warnings.push(
        `${target.page.name}: 가리기와 겹치는 효과음 ${held}개를 보류했습니다.`,
      );
    if (!target.regions.length) continue;
    throwIfAborted(abortController.signal);
    emitSoundEffectPageRunning(
      id,
      emit,
      target.page,
      pageIndex,
      prepared.targets.length,
    );
    const translated = await (
      dependencies.translateRegions ?? translateStoredSoundEffectRegions
    )({
      abortController,
      context,
      endpoint: prepared.endpoint,
      pageIndex,
      run: prepared.run,
      runPaths: prepared.runPaths,
      target,
      workContext: {
        ...prepared.workContext,
        chapterId: request.chapterId,
        recentPageCount: 6,
      },
    });
    state.warnings.push(...translated.warnings);
    const page = {
      target,
      items: translated.items,
      pageIndex,
      pageTotal: prepared.targets.length,
    };
    if (request.autoFontMatching || request.codexTypesetting) {
      deferredPages.push(page);
    } else {
      await saveTranslatedPage(input, prepared, page, dependencies);
    }
  }
}

async function saveTranslatedPage(
  input: SoundEffectTranslationJobInput,
  prepared: Awaited<ReturnType<typeof prepareSoundEffectTranslationRun>>,
  page: DeferredSoundEffectPage,
  dependencies: SoundEffectTranslationJobRunnerDependencies,
  finalizationSignal = input.abortController.signal,
  imageErrors?: unknown[],
): Promise<void> {
  const { emit, id, request, state } = input;
  const { items, pageIndex, pageTotal, target } = page;
  if (items.length === 0) {
    emitSoundEffectPageDone(id, emit, pageIndex, pageTotal, 0);
    return;
  }
  const translatedEntries =
    page.entries ??
    (await buildPageEntries(input, prepared, page, finalizationSignal));
  const {
    entries,
    image,
    error: imageError,
  } = await editSoundEffectPage(
    input,
    prepared.runPaths.runDir,
    page,
    translatedEntries,
    dependencies.editImages,
    Boolean(imageErrors?.length),
  );
  finalizationSignal.throwIfAborted();
  state.chapter = await dependencies.appendResolvedBlocks(
    request.chapterId,
    target.page.id,
    target.revision,
    entries,
    image,
  );
  state.createdBlocksByPage.push({
    pageId: target.page.id,
    blockIds: entries.flatMap((entry) => [
      entry.block.id,
      ...(entry.additionalBlocks ?? []).map((block) => block.id),
    ]),
  });
  state.translatedRegionCount += entries.length;
  if (imageError && !imageErrors) throw imageError;
  if (imageError) imageErrors?.push(imageError);
  else emitSoundEffectPageDone(id, emit, pageIndex, pageTotal, entries.length);
}

function buildPageEntries(
  input: SoundEffectTranslationJobInput,
  prepared: Awaited<ReturnType<typeof prepareSoundEffectTranslationRun>>,
  page: DeferredSoundEffectPage,
  signal = input.abortController.signal,
) {
  return buildFontMatchedSoundEffectEntries({
    baseOptions: prepared.run.baseOptions,
    fontMatchingPort: prepared.pipelineDependencies.fontMatching.pageInference,
    jobId: input.id,
    page: page.target.page,
    pageIndex: page.pageIndex,
    regions: page.target.regions,
    signal,
    translations: page.items,
  });
}

async function saveDeferredFontMatchedPages(
  input: SoundEffectTranslationJobInput,
  prepared: Awaited<ReturnType<typeof prepareSoundEffectTranslationRun>>,
  dependencies: SoundEffectTranslationJobRunnerDependencies,
  pages: readonly DeferredSoundEffectPage[],
): Promise<void> {
  if (pages.length === 0) return;
  const signal = input.abortController.signal;
  const imageErrors: unknown[] = [];
  let nextPageIndex = 0;
  try {
    await reviewSoundEffectImages(input, pages, (page) =>
      buildPageEntries(input, prepared, page),
    );
    for (const [pageIndex, page] of pages.entries()) {
      throwIfAborted(signal);
      await saveTranslatedPage(
        input,
        prepared,
        page,
        dependencies,
        signal,
        imageErrors,
      );
      nextPageIndex = pageIndex + 1;
    }
  } catch (error) {
    if (
      !signal.aborted ||
      (!isAbortErrorLike(error) && error !== signal.reason)
    )
      throw error;
  }
  rejectUnconfirmedCancellation(input, pages);
  if (nextPageIndex < pages.length) {
    const finalizationSignal = new AbortController().signal;
    prepared.run.baseOptions.autoFontMatching = undefined;
    prepared.run.baseOptions.fontMatchingCandidates = undefined;
    input.state.warnings.push(
      input.request.codexTypesetting
        ? "취소 전에 확정한 효과음 번역문과 영역을 저장했습니다."
        : "취소 전에 번역이 끝난 효과음은 폰트 자동 맞춤 없이 저장했습니다.",
    );
    const savedPageIds = new Set(
      input.state.createdBlocksByPage.map(({ pageId }) => pageId),
    );
    for (const page of pages.slice(nextPageIndex)) {
      if (savedPageIds.has(page.target.page.id)) continue;
      await saveTranslatedPage(
        input,
        prepared,
        page,
        dependencies,
        finalizationSignal,
        imageErrors,
      );
    }
  }
  if (imageErrors.length) throw imageErrors[0];
  signal.throwIfAborted();
}

function rejectUnconfirmedCancellation(
  input: SoundEffectTranslationJobInput,
  pages: readonly DeferredSoundEffectPage[],
) {
  if (
    input.request.codexTypesetting &&
    !pages.every((page) => !page.items.length || page.reading)
  )
    input.abortController.signal.throwIfAborted();
}

export async function handleSoundEffectTranslationJobError({
  abortController,
  emit,
  error,
  id,
  request,
  state,
  context,
  dependencies = productionDependencies,
}: Omit<SoundEffectTranslationJobInput, "registerResourceCleanup"> & {
  error: unknown;
  dependencies?: SoundEffectTranslationJobRunnerDependencies;
}): Promise<StartSoundEffectTranslationResult> {
  const cancelled = abortController.signal.aborted || isAbortErrorLike(error);
  const chapter = await dependencies
    .openChapter(request.chapterId)
    .catch(() => state.chapter ?? undefined);
  const remainingRegionCount = chapter
    ? countChapterPendingSoundEffectRegions(chapter)
    : 0;
  if (cancelled) {
    emitSoundEffectTerminal(
      id,
      emit,
      "cancelled",
      context.jobs.current?.lastEvent?.pageTotal ?? 0,
      state.translatedRegionCount,
    );
    return {
      status: "cancelled",
      chapter,
      createdBlocksByPage: state.createdBlocksByPage,
      translatedRegionCount: state.translatedRegionCount,
      remainingRegionCount,
      ...(state.warnings.length > 0 ? { warnings: state.warnings } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const status = state.translatedRegionCount > 0 ? "partial" : "failed";
  emit({
    id,
    kind: "sound-effect-translation",
    status,
    progressText:
      state.translatedRegionCount > 0
        ? "효과음 번역 일부 완료"
        : "효과음 번역 실패",
    phase: status,
    detail: message,
  });
  return {
    status,
    chapter,
    createdBlocksByPage: state.createdBlocksByPage,
    translatedRegionCount: state.translatedRegionCount,
    remainingRegionCount,
    warnings: state.warnings,
    error: message,
  };
}
