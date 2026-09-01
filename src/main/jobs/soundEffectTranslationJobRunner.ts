import type {
  StartSoundEffectTranslationRequest,
  StartSoundEffectTranslationResult,
} from "../../shared/analysisTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { ChapterSnapshot } from "../../shared/libraryTypes";
import {
  appendResolvedSoundEffectBlocks,
  getRunPaths,
  openChapter,
  resolveWorkContextForChapter,
} from "../library";
import { startAnalysisEndpointSession } from "../pipeline/endpointSession";
import { throwIfAborted } from "../pipeline/failure";
import { prepareFontMatchingRuntimeForRun } from "../pipeline/fontMatchingRuntimeAssets";
import { formatGemmaVramMode } from "../pipeline/options";
import { prepareAnalysisRun } from "../pipeline/prepareAnalysisRun";
import { configureWholePageOutputOptions } from "../pipeline/wholePageOutputOptions";
import { createDefaultWholePagePipelineDependencies } from "../pipeline/wholePagePipelinePorts";
import type { JobResourceCleanup } from "./jobLifetimeCleanup";
import type { TranslationJobContext } from "./translationJobTypes";
import {
  emitSoundEffectPageDone,
  emitSoundEffectPageRunning,
  emitSoundEffectTerminal,
} from "./soundEffectTranslationEvents";
import { buildFontMatchedSoundEffectEntries } from "./soundEffectFontMatching";
import type { ValidatedSoundEffectTranslation } from "./soundEffectTranslationResult";
import { maybeInpaintTranslatedSoundEffectBlocks } from "./soundEffectTranslationInpainting";
import { translateStoredSoundEffectRegions } from "./soundEffectTranslationPage";
import { inpaintCreatedSoundEffectBlocks } from "./soundEffectTargetedInpainting";
import {
  countChapterPendingSoundEffectRegions,
  resolveStoredSoundEffectTargets,
  type StoredSoundEffectTarget,
} from "./soundEffectTranslationTargets";

type EmitJobEvent = (event: JobEvent) => void;

type SoundEffectTranslationJobInput = {
  context: TranslationJobContext;
  request: StartSoundEffectTranslationRequest;
  id: string;
  abortController: AbortController;
  emit: EmitJobEvent;
  state: SoundEffectTranslationJobState;
  registerResourceCleanup: (cleanup: JobResourceCleanup) => void;
};

export type SoundEffectTranslationJobState = {
  chapter: ChapterSnapshot | null;
  createdBlocksByPage: Array<{ pageId: string; blockIds: string[] }>;
  translatedRegionCount: number;
  warnings: string[];
};

export type SoundEffectTranslationJobRunnerDependencies = {
  appendResolvedBlocks: typeof appendResolvedSoundEffectBlocks;
  createPipelineDependencies: typeof createDefaultWholePagePipelineDependencies;
  getRunPaths: typeof getRunPaths;
  openChapter: typeof openChapter;
  resolveWorkContext: typeof resolveWorkContextForChapter;
  inpaintCreatedBlocks: typeof inpaintCreatedSoundEffectBlocks;
};

const productionDependencies: SoundEffectTranslationJobRunnerDependencies = {
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
  const prepared = await prepareSoundEffectTranslationRun(input, dependencies);
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
    inpaintCreatedBlocks: dependencies.inpaintCreatedBlocks,
    pageTotal: prepared.targets.length,
  });
  return finalizeSoundEffectTranslation(input, prepared, dependencies);
}

async function prepareSoundEffectTranslationRun(
  input: SoundEffectTranslationJobInput,
  dependencies: SoundEffectTranslationJobRunnerDependencies,
) {
  const { abortController, emit, id, registerResourceCleanup, request, state } =
    input;
  throwIfAborted(abortController.signal);
  const chapter = await dependencies.openChapter(request.chapterId);
  state.chapter = chapter;
  const targets = resolveStoredSoundEffectTargets(chapter, request);
  const requestedRegionCount = targets.reduce(
    (count, target) => count + target.regions.length,
    0,
  );
  const runPaths = await dependencies.getRunPaths(request.chapterId, id);
  const workContext = await dependencies.resolveWorkContext(request.chapterId);
  const pipelineDependencies = dependencies.createPipelineDependencies();
  await prepareFontMatchingRuntimeForRun(
    {
      autoFontMatching: request.autoFontMatching,
      emit,
      jobId: id,
      signal: abortController.signal,
    },
    pipelineDependencies.paths,
    dependencies !== productionDependencies,
  );
  const run = await prepareAnalysisRun({
    jobId: id,
    emit,
    pages: targets.map((target) => target.page),
    runPaths,
    runtime: pipelineDependencies.runtime,
    signal: abortController.signal,
    skipOcrPrepass: true,
    dependencies: pipelineDependencies,
  });
  await configureWholePageOutputOptions({
    autoFontMatching: request.autoFontMatching === true,
    chapterId: request.chapterId,
    dependencies: pipelineDependencies,
    naturalTextLayout: false,
    aiFontSizeMatching: false,
    run,
    workId: workContext.workId,
  });
  const endpoint = await startAnalysisEndpointSession({
    apiSelected: run.apiSelected,
    baseOptions: run.baseOptions,
    codexSelected: run.codexSelected,
    formatGemmaVramMode,
    localModelSelected: run.localModelSelected,
    modelCached: run.modelCached,
    onCleanupReady: registerResourceCleanup,
    progressContext: run.progressContext,
    runtime: run.runtime,
  });
  return {
    endpoint,
    pipelineDependencies,
    requestedRegionCount,
    run,
    runPaths,
    targets,
    workContext,
  };
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
  for (const [pageIndex, target] of prepared.targets.entries()) {
    throwIfAborted(abortController.signal);
    emitSoundEffectPageRunning(
      id,
      emit,
      target.page,
      pageIndex,
      prepared.targets.length,
    );
    const translated = await translateStoredSoundEffectRegions({
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
  const entries = await buildFontMatchedSoundEffectEntries({
    baseOptions: prepared.run.baseOptions,
    fontMatchingPort: prepared.pipelineDependencies.fontMatching.pageInference,
    jobId: id,
    page: target.page,
    pageIndex,
    regions: target.regions,
    signal: finalizationSignal,
    translations: items,
  });
  state.chapter = await dependencies.appendResolvedBlocks(
    request.chapterId,
    target.page.id,
    target.revision,
    entries,
  );
  state.createdBlocksByPage.push({
    pageId: target.page.id,
    blockIds: entries.map((entry) => entry.block.id),
  });
  state.translatedRegionCount += entries.length;
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

function throwSoundEffectPhaseErrors(
  translationError: unknown,
  finalizationError: unknown,
): void {
  if (translationError && finalizationError) {
    throw new AggregateError(
      [translationError, finalizationError],
      "효과음 번역과 결과 저장이 모두 실패했습니다.",
    );
  }
  if (translationError) throw translationError;
  if (finalizationError) throw finalizationError;
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
  const cancelled =
    abortController.signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError");
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
  emit({
    id,
    kind: "sound-effect-translation",
    status: "failed",
    progressText: "효과음 번역 실패",
    phase: "failed",
    detail: message,
  });
  return {
    status: state.translatedRegionCount > 0 ? "partial" : "failed",
    chapter,
    createdBlocksByPage: state.createdBlocksByPage,
    translatedRegionCount: state.translatedRegionCount,
    remainingRegionCount,
    warnings: state.warnings,
    error: message,
  };
}
