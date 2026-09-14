import type { MangaPage } from "../../shared/libraryTypes";
import { isJapaneseLanguageCode } from "../../shared/translationLanguages";
import { preparePageOcrHints } from "./pageOcrPreparation";
import { resolveReusableTranslationCheckpoints } from "./wholePageCheckpointFlow";
import {
  filterPagesByOcrText,
  completePrepassNoTextPages,
} from "./pageFiltering";
import { persistPageContextAfterSuccess } from "./pageContextPersistence";
import type { AnalysisRun } from "./prepareAnalysisRun";
import type { PipelineOptions, OcrBboxResult } from "./types";
import type { WholePagePipelineDependencies } from "./wholePagePipelinePorts";
import type { PreparedTranslationCheckpoint } from "./preparedTranslationCheckpointContract";
import type { PageProcessingTimingCollector } from "./pageProcessingTiming";
import type { WarningCollector } from "./warningCollector";

type InputOptions = Pick<
  PipelineOptions,
  | "acquirePage"
  | "onPageSettled"
  | "onPageComplete"
  | "blockMode"
  | "decodeImage"
  | "runPaths"
  | "signal"
  | "regionContext"
  | "workContext"
  | "collectPageContext"
  | "cumulativeContextDetail"
  | "writeStoryMemory"
  | "skipOcrPrepass"
> & {
  run: AnalysisRun;
  dependencies: WholePagePipelineDependencies;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  timing: PageProcessingTimingCollector;
  warningCollector: WarningCollector;
};

export async function refreshWholePageInput(
  original: MangaPage,
  checkpoints: Map<string, PreparedTranslationCheckpoint>,
  options: InputOptions,
): Promise<MangaPage> {
  if (!options.acquirePage) return original;
  const page = await options.acquirePage(original.id);
  options.signal.throwIfAborted();
  const reusable = resolveReusableTranslationCheckpoints(
    [page],
    checkpoints,
    options.run.baseOptions,
    options.blockMode,
    options.dependencies.diagnostics.warn,
  );
  if (!reusable.has(page.id)) checkpoints.delete(page.id);
  if (
    !checkpoints.has(page.id) &&
    (options.blockMode === "keep" || !options.ocrHintsByPageId.has(page.id))
  ) {
    const hints = await preparePageOcrHints({
      jobId: options.run.progressContext.jobId,
      pages: [page],
      run: options.run,
      runPaths: options.runPaths,
      signal: options.signal,
      skipOcrPrepass: options.skipOcrPrepass ?? false,
      blockMode: options.blockMode,
      decodeImage: options.decodeImage,
      regionContext: options.regionContext,
      diagnostics: options.dependencies.diagnostics,
    });
    for (const [id, hint] of hints) options.ocrHintsByPageId.set(id, hint);
  }
  return page;
}

export async function completeHandedOffNoTextPage(
  page: MangaPage,
  pageIndex: number,
  options: InputOptions,
): Promise<MangaPage | undefined> {
  const filtered = filterPagesByOcrText([page], options.ocrHintsByPageId, {
    allowNoTextSkip:
      !options.collectPageContext &&
      isJapaneseLanguageCode(options.run.baseOptions.sourceLanguage),
    ocrPipeline: options.run.baseOptions.ocrPipeline,
  });
  const entry = filtered.prepassNoTextPages[0];
  if (!entry) return undefined;
  entry.pageIndex = pageIndex;
  entry.page = options.timing.applyTranslationTiming(entry.page);
  const accepted = await completePrepassNoTextPages({
    context: options.run.progressContext,
    onPageComplete: options.onPageComplete,
    prepassNoTextPages: [entry],
  });
  if (accepted.has(page.id) && options.writeStoryMemory !== false) {
    await persistPageContextAfterSuccess(
      {
        page: entry.page,
        pageIndex,
        ocrResult: options.ocrHintsByPageId.get(page.id),
        collectPageContext: options.collectPageContext ?? false,
        cumulativeContextDetail: options.cumulativeContextDetail ?? "detailed",
        warningCollector: options.warningCollector,
        workContext: options.workContext,
      },
      {
        repository: options.dependencies.pageContext,
        logger: { warn: options.dependencies.diagnostics.warn },
      },
    );
  }
  options.onPageSettled?.(page.id, !accepted.has(page.id));
  return entry.page;
}
