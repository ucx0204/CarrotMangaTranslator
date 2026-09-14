import { startAnalysisEndpointSession } from "../pipeline/endpointSession";
import { prepareFontMatchingRuntimeForRun } from "../pipeline/fontMatchingRuntimeAssets";
import { formatGemmaVramMode } from "../pipeline/options";
import { prepareAnalysisRun } from "../pipeline/prepareAnalysisRun";
import { configureWholePageOutputOptions } from "../pipeline/wholePageOutputOptions";
import { throwIfAborted } from "../pipeline/failure";
import { resolveStoredSoundEffectTargets } from "./soundEffectTranslationTargets";
import type { createDefaultWholePagePipelineDependencies } from "../pipeline/wholePagePipelinePorts";
import type { SoundEffectPreparationDependencies } from "./translationJobTypes";
import type { SoundEffectTranslationJobInput } from "./translationJobTypes";
import { acquireJobPage, reserveJobChapter } from "./jobPageOwnership";
import { createSoundEffectReviewPageRevision } from "../../shared/pageRevision";
export async function prepareSoundEffectTranslationRun(
  input: SoundEffectTranslationJobInput,
  dependencies: SoundEffectPreparationDependencies,
  pipelineDependencies: ReturnType<
    typeof createDefaultWholePagePipelineDependencies
  >,
  injected: boolean,
) {
  const { abortController, emit, id, registerResourceCleanup, request, state } =
    input;
  throwIfAborted(abortController.signal);
  const chapter = await dependencies.openChapter(request.chapterId);
  state.chapter = chapter;
  reserveJobChapter(
    input.context.jobs,
    id,
    chapter,
    request.targets.map((target) => target.pageId),
    [{ kind: "work-context", scope: chapter.workId, access: "read" }],
  );
  const targets = resolveStoredSoundEffectTargets(chapter, request);
  const requestedRegionCount = targets.reduce(
    (count, target) => count + target.regions.length,
    0,
  );
  const runPaths = await dependencies.getRunPaths(request.chapterId, id);
  const workContext = await dependencies.resolveWorkContext(request.chapterId);
  await prepareFontMatchingRuntimeForRun(
    {
      autoFontMatching: request.autoFontMatching,
      emit,
      jobId: id,
      signal: abortController.signal,
    },
    pipelineDependencies.paths,
    injected,
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

export async function refreshSoundEffectTarget(
  input: SoundEffectTranslationJobInput,
  initial: ReturnType<typeof resolveStoredSoundEffectTargets>[number],
  openChapter: SoundEffectPreparationDependencies["openChapter"],
): Promise<ReturnType<typeof resolveStoredSoundEffectTargets>[number]> {
  const { context, id, request, state } = input;
  if (!context.jobs.get(id)?.resources) return initial;
  const page = await acquireJobPage(
    context.jobs,
    id,
    request.chapterId,
    initial.page.id,
    openChapter,
  );
  const chapter = state.chapter;
  if (!chapter) throw new Error("효과음 번역 화를 찾지 못했습니다.");
  const [latest] = resolveStoredSoundEffectTargets(
    { ...chapter, pages: [page] },
    {
      ...request,
      targets: [
        {
          pageId: page.id,
          pageRevision: createSoundEffectReviewPageRevision(page),
          regionIds: initial.regions.map((region) => region.id),
        },
      ],
    },
  );
  return { ...latest, pageIndex: initial.pageIndex };
}
