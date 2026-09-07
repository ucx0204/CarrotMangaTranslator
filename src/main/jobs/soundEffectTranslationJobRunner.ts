import { applySoundEffectImageEdit } from "./soundEffectImageEditing";
import { externalImageRegionIsHidden } from "../imageRedactionContext";
import { withImageRedactionReview } from "./imageRedactionReview";
import { prepareSoundEffectTranslationRun } from "./soundEffectTranslationPreparation";
import { editTranslatedPageWithCodex } from "../codexImageEditing";
import { createCodexProgressReporter } from "../pipeline/codexTypesettingProgress";
import type {
  StartSoundEffectTranslationRequest,
  StartSoundEffectTranslationResult,
} from "../../shared/analysisTypes";
import type { JobEvent } from "../../shared/jobTypes";
import {
  appendResolvedSoundEffectBlocks,
  getRunPaths,
  openChapter,
  resolveWorkContextForChapter,
} from "../library";
import { isAbortErrorLike, throwIfAborted } from "../pipeline/failure";
import { createDefaultWholePagePipelineDependencies } from "../pipeline/wholePagePipelinePorts";
import type {
  TranslationJobContext,
  SoundEffectTranslationJobInput,
  SoundEffectTranslationJobState,
} from "./translationJobTypes";
import {
  emitSoundEffectPageDone,
  emitSoundEffectPageRunning,
  emitSoundEffectTerminal,
} from "./soundEffectTranslationEvents";
import { buildFontMatchedSoundEffectEntries } from "./soundEffectFontMatching";
import {
  throwSoundEffectPhaseErrors,
  type ValidatedSoundEffectTranslation,
} from "./soundEffectTranslationResult";
import { maybeInpaintTranslatedSoundEffectBlocks } from "./soundEffectTranslationInpainting";
import { translateStoredSoundEffectRegions } from "./soundEffectTranslationPage";
import { inpaintCreatedSoundEffectBlocks } from "./soundEffectTargetedInpainting";
import {
  countChapterPendingSoundEffectRegions,
  resolveStoredSoundEffectTargets,
  type StoredSoundEffectTarget,
} from "./soundEffectTranslationTargets";

type EmitJobEvent = (event: JobEvent) => void;

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
    return finalizeSoundEffectTranslation(input, prepared, dependencies);
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

type DeferredSoundEffectPage = {
  target: StoredSoundEffectTarget;
  items: ValidatedSoundEffectTranslation[];
  pageIndex: number;
  pageTotal: number;
};

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
    if (request.autoFontMatching) {
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
  const translatedEntries = await buildFontMatchedSoundEffectEntries({
    baseOptions: prepared.run.baseOptions,
    fontMatchingPort: prepared.pipelineDependencies.fontMatching.pageInference,
    jobId: id,
    page: target.page,
    pageIndex,
    regions: target.regions,
    signal: finalizationSignal,
    translations: items,
  });
  const reportImageProgress = createCodexProgressReporter(
    id,
    pageTotal,
    emit,
    "sound-effect-translation",
  );
  const {
    entries,
    image,
    error: imageError,
  } = request.codexTypesetting && !input.abortController.signal.aborted
    ? await applySoundEffectImageEdit(
        translatedEntries,
        {
          page: {
            ...target.page,
            blocks: translatedEntries.map((entry) => entry.block),
          },
          directory: prepared.runPaths.runDir,
          signal: input.abortController.signal,
          eraseOriginal: request.inpaintAfterTranslation,
          output:
            request.codexTypesetting.sfxRendering === "font" ? "text" : "image",
          decode: input.context.decodeImage,
          progress: (update) =>
            reportImageProgress({
              ...update,
              stage: "images",
              page: pageIndex + 1,
              completed: pageIndex,
            }),
        },
        dependencies.editImages,
      )
    : { entries: translatedEntries, image: undefined, error: undefined };
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
    blockIds: entries.map((entry) => entry.block.id),
  });
  state.translatedRegionCount += entries.length;
  if (imageError) throw imageError;
  emitSoundEffectPageDone(id, emit, pageIndex, pageTotal, entries.length);
}

async function saveDeferredFontMatchedPages(
  input: SoundEffectTranslationJobInput,
  prepared: Awaited<ReturnType<typeof prepareSoundEffectTranslationRun>>,
  dependencies: SoundEffectTranslationJobRunnerDependencies,
  pages: readonly DeferredSoundEffectPage[],
): Promise<void> {
  if (pages.length === 0) return;
  const cancelled = input.abortController.signal.aborted;
  const finalizationSignal = cancelled
    ? new AbortController().signal
    : input.abortController.signal;
  if (cancelled) {
    prepared.run.baseOptions.autoFontMatching = undefined;
    prepared.run.baseOptions.fontMatchingCandidates = undefined;
    input.state.warnings.push(
      "취소 전에 번역이 끝난 효과음은 폰트 자동 맞춤 없이 저장했습니다.",
    );
  }
  for (const page of pages) {
    await saveTranslatedPage(
      input,
      prepared,
      page,
      dependencies,
      finalizationSignal,
    );
  }
}

async function finalizeSoundEffectTranslation(
  input: SoundEffectTranslationJobInput,
  prepared: Awaited<ReturnType<typeof prepareSoundEffectTranslationRun>>,
  dependencies: SoundEffectTranslationJobRunnerDependencies,
): Promise<StartSoundEffectTranslationResult> {
  const { emit, id, request, state } = input;
  state.chapter = await dependencies.openChapter(request.chapterId);
  const remainingRegionCount = countChapterPendingSoundEffectRegions(
    state.chapter,
  );
  const failedRequested =
    prepared.requestedRegionCount - state.translatedRegionCount;
  const status = failedRequested > 0 ? "partial" : "completed";
  emitSoundEffectTerminal(
    id,
    emit,
    status,
    prepared.targets.length,
    state.translatedRegionCount,
  );
  return {
    status,
    chapter: state.chapter,
    createdBlocksByPage: state.createdBlocksByPage,
    translatedRegionCount: state.translatedRegionCount,
    remainingRegionCount,
    ...(state.warnings.length > 0 ? { warnings: state.warnings } : {}),
  };
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
}: {
  abortController: AbortController;
  emit: EmitJobEvent;
  error: unknown;
  id: string;
  request: StartSoundEffectTranslationRequest;
  state: SoundEffectTranslationJobState;
  context: TranslationJobContext;
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
