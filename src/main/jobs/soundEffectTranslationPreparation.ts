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
