/* eslint-disable max-lines -- pipeline cancellation boundaries and endpoint ownership stay co-located for auditability */
import type { MangaPage } from "../shared/libraryTypes";
import { isJapaneseLanguageCode } from "../shared/translationLanguages";
import { tMain } from "./i18n";
import {
  startAnalysisEndpointSession,
  type AnalysisEndpointSession,
} from "./pipeline/endpointSession";
import { throwIfAborted } from "./pipeline/failure";
import {
  buildPipelinePages,
  completePrepassNoTextPages,
  filterPagesByOcrText,
} from "./pipeline/pageFiltering";
import { formatGemmaVramMode } from "./pipeline/options";
import { prepareAnalysisRun } from "./pipeline/prepareAnalysisRun";
import { prepareFontMatchingRuntimeForRun } from "./pipeline/fontMatchingRuntimeAssets";
import { emitFinalizing } from "./pipeline/progressEvents";
import { translatePageWithRetries } from "./pipeline/translatePageWithRetries";
import type { OcrBboxResult, PipelineOptions } from "./pipeline/types";
import { createWarningCollector } from "./pipeline/warningCollector";
import {
  persistPageContextAfterSuccess,
  type PageContextPersistenceDependencies,
} from "./pipeline/pageContextPersistence";
import { preparePageOcrHints } from "./pipeline/pageOcrPreparation";
import {
  createDefaultWholePagePipelineDependencies as createDependencies,
  type WholePagePipelineDependencies,
} from "./pipeline/wholePagePipelinePorts";
import { configureWholePageOutputOptions } from "./pipeline/wholePageOutputOptions";
import { createAutomaticFontChapterCoordinatorV2 } from "./pipeline/automaticFontMatchingV2PageCoordinator";

export async function runWholePagePipeline(
  options: PipelineOptions,
  injectedDependencies?: WholePagePipelineDependencies,
): Promise<{ pages: MangaPage[]; warnings: string[] }> {
  if (options.pages.length === 0) return { pages: [], warnings: [] };
  const ownsDependencies = injectedDependencies === undefined;
  const dependencies = injectedDependencies ?? createDependencies();
  try {
    return await runWholePagePipelineWithDependencies(
      options,
      dependencies,
      !ownsDependencies,
    );
  } finally {
    if (ownsDependencies) {
      await dependencies.fontMatching.pageInference?.dispose?.();
    }
  }
}

// eslint-disable-next-line max-lines-per-function -- major await-boundary abort checks stay with the pipeline transaction
async function runWholePagePipelineWithDependencies(
  options: PipelineOptions,
  dependencies: WholePagePipelineDependencies,
  injectedDependencies: boolean,
): Promise<{ pages: MangaPage[]; warnings: string[] }> {
  const {
    onCleanupReady,
    onPageComplete,
    onPagesComplete,
    onPageFailed,
    pages,
    runPaths,
    signal,
    skipOcrPrepass = false,
    blockMode,
    workContext,
    regionContext,
    writeStoryMemory = true,
    collectPageContext = false,
    naturalTextLayout = false,
    autoFontMatching = false,
    canonicalPageIndexById,
  } = options;
  throwIfAborted(signal);
  const { ocrHintsByPageId, run } = await prepareWholePageRun(
    options,
    dependencies,
    injectedDependencies,
  );
  throwIfAborted(signal);
  await configureWholePageOutputOptions({
    autoFontMatching,
    chapterId: workContext?.chapterId,
    dependencies,
    naturalTextLayout,
    run,
    workId: workContext?.workId,
  });
  throwIfAborted(signal);
  const warningCollector = createPipelineWarnings(signal);

  const filtered = filterPagesByOcrText(pages, ocrHintsByPageId, {
    allowNoTextSkip: !collectPageContext && allowOcrNoTextSkip(run.baseOptions),
  });
  throwIfAborted(signal);
  const approvedPrepassPageIds = await completePrepassNoTextPages({
    context: run.progressContext,
    onPageComplete,
    onPagesComplete,
    prepassNoTextPages: filtered.prepassNoTextPages,
  });
  throwIfAborted(signal);
  await persistPrepassPageContexts({
    approvedPrepassPageIds,
    canonicalPageIndexById,
    dependencies,
    filtered,
    ocrHintsByPageId,
    warningCollector,
    workContext,
    writeStoryMemory,
    signal,
  });
  throwIfAborted(signal);

  return completeWholePageRun({
    blockMode,
    canonicalPageIndexById,
    collectPageContext,
    filtered,
    ocrHintsByPageId,
    onCleanupReady,
    onPageComplete,
    onPageFailed,
    pages,
    regionContext,
    run,
    runPaths,
    signal,
    skipOcrPrepass,
    warningCollector,
    workContext,
    writeStoryMemory,
    dependencies,
  });
}

async function persistPrepassPageContexts({
  approvedPrepassPageIds,
  canonicalPageIndexById,
  dependencies,
  filtered,
  ocrHintsByPageId,
  warningCollector,
  workContext,
  writeStoryMemory,
  signal,
}: {
  approvedPrepassPageIds: ReadonlySet<string>;
  canonicalPageIndexById?: PipelineOptions["canonicalPageIndexById"];
  dependencies: WholePagePipelineDependencies;
  filtered: ReturnType<typeof filterPagesByOcrText>;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  warningCollector: ReturnType<typeof createWarningCollector>;
  workContext?: PipelineOptions["workContext"];
  writeStoryMemory: boolean;
  signal: AbortSignal;
}): Promise<void> {
  if (!writeStoryMemory || !workContext) return;
  for (const entry of filtered.prepassNoTextPages) {
    throwIfAborted(signal);
    if (!approvedPrepassPageIds.has(entry.page.id)) continue;
    await persistPageContextAfterSuccess(
      {
        page: entry.page,
        pageIndex:
          canonicalPageIndexById?.get(entry.page.id) ?? entry.pageIndex,
        ocrResult: ocrHintsByPageId.get(entry.page.id),
        collectPageContext: false,
        warningCollector,
        workContext,
      },
      pageContextDependencies(dependencies),
    );
    throwIfAborted(signal);
  }
}

async function completeWholePageRun({
  blockMode,
  canonicalPageIndexById,
  collectPageContext,
  filtered,
  ocrHintsByPageId,
  onCleanupReady,
  onPageComplete,
  onPageFailed,
  pages,
  regionContext,
  run,
  runPaths,
  signal,
  skipOcrPrepass,
  warningCollector,
  workContext,
  writeStoryMemory,
  dependencies,
}: Pick<
  PipelineOptions,
  | "blockMode"
  | "canonicalPageIndexById"
  | "collectPageContext"
  | "onCleanupReady"
  | "onPageComplete"
  | "onPageFailed"
  | "pages"
  | "regionContext"
  | "runPaths"
  | "signal"
  | "workContext"
  | "writeStoryMemory"
> & {
  filtered: ReturnType<typeof filterPagesByOcrText>;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
  skipOcrPrepass: boolean;
  warningCollector: ReturnType<typeof createWarningCollector>;
  dependencies: WholePagePipelineDependencies;
}): Promise<{ pages: MangaPage[]; warnings: string[] }> {
  throwIfAborted(signal);
  if (filtered.pagesToTranslate.length === 0) {
    emitPagesReadyWithoutModel(run.progressContext, pages.length);
    return buildPipelineResult(pages, filtered, warningCollector);
  }
  const endpoint = await startWholePageEndpoint({ onCleanupReady, run });
  try {
    await translatePages({
      endpoint,
      filtered,
      ocrHintsByPageId,
      onPageComplete,
      onPageFailed,
      run,
      runPaths,
      signal,
      skipOcrPrepass,
      blockMode,
      warningCollector,
      workContext,
      regionContext,
      writeStoryMemory: writeStoryMemory ?? true,
      collectPageContext: collectPageContext ?? false,
      canonicalPageIndexById,
      dependencies,
    });
    emitFinalizing(
      run.progressContext,
      tMain("translation.progress.pagesReady", { count: pages.length }),
    );
    return buildPipelineResult(pages, filtered, warningCollector);
  } finally {
    await endpoint.disposeEndpointSession();
  }
}

function emitPagesReadyWithoutModel(
  context: Parameters<typeof emitFinalizing>[0],
  count: number,
): void {
  const message = tMain("translation.progress.pagesReadyNoModel", { count });
  emitFinalizing(context, message);
}

/** OCR "텍스트 없음" 스킵은 일본어 원문에서만 허용한다. */
function allowOcrNoTextSkip(baseOptions: { sourceLanguage?: string }): boolean {
  return isJapaneseLanguageCode(baseOptions.sourceLanguage);
}

function createPipelineWarnings(signal: AbortSignal) {
  const collector = createWarningCollector();
  throwIfAborted(signal);
  return collector;
}

function buildPipelineResult(
  pages: MangaPage[],
  filtered: ReturnType<typeof filterPagesByOcrText>,
  warningCollector: ReturnType<typeof createWarningCollector>,
): { pages: MangaPage[]; warnings: string[] } {
  const completedPages = buildPipelinePages(pages, filtered.completedPagesById);
  return { pages: completedPages, warnings: warningCollector.warnings };
}

async function prepareWholePageRun(
  options: PipelineOptions,
  dependencies: WholePagePipelineDependencies,
  injected: boolean,
): Promise<{
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
}> {
  // Download the externalized font matching runtime bundle (excluded from the
  // installer; see electron-builder.config.cjs `font-matching/**` filter) into
  // the writable data-root cache before configureWholePageOutputOptions (the
  // first loadCandidates call). No-op for injected deps (tests) and when auto
  // font matching is off; non-abort failures degrade fail-closed.
  await prepareFontMatchingRuntimeForRun(options, dependencies.paths, injected);
  throwIfAborted(options.signal);
  const {
    blockMode,
    decodeImage,
    emit,
    jobId,
    pages,
    regionContext,
    runPaths,
    signal,
    skipOcrPrepass = false,
  } = options;
  const run = await prepareAnalysisRun({
    jobId,
    emit,
    pages,
    runPaths,
    runtime: dependencies.runtime,
    signal,
    skipOcrPrepass,
    dependencies,
  });
  throwIfAborted(signal);
  const ocrHintsByPageId = await preparePageOcrHints({
    jobId,
    pages,
    run,
    runPaths,
    signal,
    skipOcrPrepass,
    blockMode,
    decodeImage,
    regionContext,
    diagnostics: dependencies.diagnostics,
  });
  throwIfAborted(signal);
  return { ocrHintsByPageId, run };
}

async function startWholePageEndpoint({
  onCleanupReady,
  run,
}: {
  onCleanupReady?: PipelineOptions["onCleanupReady"];
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
}): Promise<AnalysisEndpointSession> {
  return startAnalysisEndpointSession({
    baseOptions: run.baseOptions,
    apiSelected: run.apiSelected,
    codexSelected: run.codexSelected,
    formatGemmaVramMode,
    localModelSelected: run.localModelSelected,
    modelCached: run.modelCached,
    onCleanupReady,
    progressContext: run.progressContext,
    runtime: run.runtime,
  });
}

// eslint-disable-next-line max-lines-per-function -- page sequencing owns one shared endpoint session
async function translatePages({
  endpoint,
  filtered,
  ocrHintsByPageId,
  onPageComplete,
  onPageFailed,
  run,
  runPaths,
  signal,
  skipOcrPrepass,
  blockMode,
  warningCollector,
  workContext,
  regionContext,
  writeStoryMemory,
  collectPageContext,
  canonicalPageIndexById,
  dependencies,
}: {
  endpoint: AnalysisEndpointSession;
  filtered: ReturnType<typeof filterPagesByOcrText>;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  onPageComplete?: PipelineOptions["onPageComplete"];
  onPageFailed?: PipelineOptions["onPageFailed"];
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
  runPaths: PipelineOptions["runPaths"];
  signal: AbortSignal;
  skipOcrPrepass: boolean;
  blockMode?: PipelineOptions["blockMode"];
  warningCollector: ReturnType<typeof createWarningCollector>;
  workContext?: PipelineOptions["workContext"];
  regionContext?: PipelineOptions["regionContext"];
  writeStoryMemory: boolean;
  collectPageContext: boolean;
  canonicalPageIndexById?: PipelineOptions["canonicalPageIndexById"];
  dependencies: WholePagePipelineDependencies;
}): Promise<void> {
  const fontMatchingChapterCoordinator = run.baseOptions.autoFontMatching
    ? createAutomaticFontChapterCoordinatorV2()
    : undefined;
  for (const page of filtered.pagesToTranslate) {
    const progressPageIndex = filtered.pageIndexById.get(page.id) ?? 0;
    const pageIndex = canonicalPageIndexById?.get(page.id) ?? progressPageIndex;
    throwIfAborted(signal);
    const translated = await translatePageWithRetries({
      baseOptions: run.baseOptions,
      completedPagesById: filtered.completedPagesById,
      context: run.progressContext,
      maxAttempts: endpoint.maxAttempts,
      ocrHintsByPageId,
      onPageComplete,
      onPageFailed,
      page,
      pageIndex,
      progressPageIndex,
      runPaths,
      runtime: run.runtime,
      server: endpoint.server,
      signal,
      skipOcrPrepass,
      blockMode,
      warningCollector,
      workContext,
      regionContext,
      collectPageContext,
      diagnostics: dependencies.diagnostics,
      fontMatchingPageInference: dependencies.fontMatching.pageInference,
      fontMatchingChapterCoordinator,
    });
    if (writeStoryMemory && translated.approved) {
      await persistPageContextAfterSuccess(
        {
          page: filtered.completedPagesById.get(page.id),
          pageIndex,
          pageContext: translated.pageContext,
          ocrResult: ocrHintsByPageId.get(page.id),
          collectPageContext,
          warningCollector,
          workContext,
        },
        pageContextDependencies(dependencies),
      );
    }
  }
}

function pageContextDependencies(
  dependencies: WholePagePipelineDependencies,
): PageContextPersistenceDependencies {
  const { pageContext: repository, diagnostics } = dependencies;
  return { repository, logger: { warn: diagnostics.warn } };
}
