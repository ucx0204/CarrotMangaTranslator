import { prepareSoundEffectPageEntries } from "./soundEffectImageEditing";
import {
  resumeSoundEffectImages,
  type SoundEffectImageRecoveryDependencies,
} from "./soundEffectImageRecoveryRunner";
import { saveSoundEffectImageRecovery } from "../soundEffectImageRecoveryStore";
import { saveConfirmedSoundEffectImages } from "./soundEffectImageFinalization";
import {
  reviewSoundEffectImages,
  type DeferredSoundEffectPage,
} from "./soundEffectTranslationReview";
import { externalImageRegionIsHidden } from "../imageRedactionContext";
import { withImageRedactionReview } from "./imageRedactionReview";
import {
  prepareSoundEffectTranslationRun,
  refreshSoundEffectTarget,
} from "./soundEffectTranslationPreparation";
import { editTranslatedPageWithCodex } from "../codexImageEditing";
import type { StartSoundEffectTranslationResult } from "../../shared/analysisTypes";
import {
  appendResolvedSoundEffectBlocks,
  getRunPaths,
  openChapter,
  resolveWorkContextForChapter,
  updatePagesAfterInpainting,
} from "../library";
import { isAbortErrorLike, throwIfAborted } from "../pipeline/failure";
import { createDefaultWholePagePipelineDependencies } from "../pipeline/wholePagePipelinePorts";
import type { SoundEffectTranslationJobInput } from "./translationJobTypes";
import {
  emitSoundEffectPageDone,
  emitSoundEffectPageRunning,
  finishFailedSoundEffectTranslation,
  finishSoundEffectTranslation,
} from "./soundEffectTranslationEvents";
import { buildFontMatchedSoundEffectEntries } from "./soundEffectFontMatching";
import { throwSoundEffectPhaseErrors } from "./soundEffectTranslationResult";
import { maybeInpaintTranslatedSoundEffectBlocks } from "./soundEffectTranslationInpainting";
import { translateStoredSoundEffectRegions } from "./soundEffectTranslationPage";
import { inpaintCreatedSoundEffectBlocks } from "./soundEffectTargetedInpainting";
import { resolveStoredSoundEffectTargets } from "./soundEffectTranslationTargets";

export type SoundEffectTranslationJobRunnerDependencies = {
  saveImages?: SoundEffectImageRecoveryDependencies["saveImages"];
  saveImageRecovery?: SoundEffectImageRecoveryDependencies["saveRecovery"];
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
  saveImages: updatePagesAfterInpainting,
  saveImageRecovery: saveSoundEffectImageRecovery,
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
  if (input.request.resumeImageRunId) return resumeSoundEffectImages(input);
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
  for (const [pageIndex, initial] of prepared.targets.entries()) {
    const original = await refreshSoundEffectTarget(
      input,
      initial,
      dependencies.openChapter,
    );
    prepared.targets[pageIndex] = original;
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
  const entries = prepareSoundEffectPageEntries(page, translatedEntries);
  finalizationSignal.throwIfAborted();
  if (!entries.length) return;
  state.chapter = await dependencies.appendResolvedBlocks(
    request.chapterId,
    target.page.id,
    target.revision,
    entries,
  );
  state.createdBlocksByPage.push({
    pageId: target.page.id,
    blockIds: entries.flatMap((entry) => [
      entry.block.id,
      ...(entry.additionalBlocks ?? []).map((block) => block.id),
    ]),
  });
  state.translatedRegionCount += entries.length;
  emitSoundEffectPageDone(id, emit, pageIndex, pageTotal, entries.length);
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
  let nextPageIndex = 0;
  try {
    await reviewSoundEffectImages(input, pages, (page) =>
      buildPageEntries(input, prepared, page),
    );
    if (input.request.codexTypesetting) {
      return saveConfirmedSoundEffectImages(
        input,
        dependencies,
        pages,
        (page) =>
          saveTranslatedPage(
            input,
            prepared,
            page,
            dependencies,
            new AbortController().signal,
          ),
      );
    }
    for (const [pageIndex, page] of pages.entries()) {
      throwIfAborted(signal);
      await saveTranslatedPage(input, prepared, page, dependencies, signal);
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
      "취소 전에 번역이 끝난 효과음은 폰트 자동 맞춤 없이 저장했습니다.",
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
      );
    }
  }
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

export function handleSoundEffectTranslationJobError(
  input: Omit<SoundEffectTranslationJobInput, "registerResourceCleanup"> & {
    error: unknown;
    dependencies?: SoundEffectTranslationJobRunnerDependencies;
  },
): Promise<StartSoundEffectTranslationResult> {
  return finishFailedSoundEffectTranslation(
    input,
    (input.dependencies ?? productionDependencies).openChapter,
  );
}
