/* eslint-disable max-lines -- pipeline cancellation boundaries and endpoint ownership stay co-located for auditability */
import type { MangaPage } from "../shared/libraryTypes";
import type { JobFailureGuidance } from "../shared/jobTypes";
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
import { preparePageWithRetries } from "./pipeline/translatePageWithRetries";
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
import { completePreparedPageTranslationAttempt } from "./pipeline/pageTranslationAttempt";
import {
  projectPreparedPageForContext,
  type PreparedPageBuildResult,
} from "./pipeline/pageResultBuilder";
import { logPipelineWarning } from "./pipeline/pipelineLogger";
import {
  createPageProcessingTimingCollector,
  measureSharedProcessingStage,
  type PageProcessingTimingCollector,
} from "./pipeline/pageProcessingTiming";

export type WholePagePipelineResult = {
  pages: MangaPage[];
  warnings: string[];
  failureGuidance?: JobFailureGuidance;
};

export async function runWholePagePipeline(
  options: PipelineOptions,
  injectedDependencies?: WholePagePipelineDependencies,
): Promise<WholePagePipelineResult> {
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
): Promise<WholePagePipelineResult> {
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
    cumulativeContextDetail = "detailed",
    naturalTextLayout = false,
    autoFontMatching = false,
    fontSizeAutoFit = true,
    canonicalPageIndexById,
  } = options;
  const timing = createPageProcessingTimingCollector(
    options.jobId,
    pages.map((page) => page.id),
  );
  throwIfAborted(signal);
  const { ocrHintsByPageId, run } = await prepareWholePageRun(
    options,
    dependencies,
    injectedDependencies,
    timing,
  );
  throwIfAborted(signal);
  await measureSharedProcessingStage(timing, "preparing", () =>
    configureWholePageOutputOptions({
      autoFontMatching,
      chapterId: workContext?.chapterId,
      dependencies,
      naturalTextLayout,
      fontSizeAutoFit,
      run,
      workId: workContext?.workId,
    }),
  );
  throwIfAborted(signal);
  const warningCollector = createPipelineWarnings(signal);

  const filtered = filterPagesByOcrText(pages, ocrHintsByPageId, {
    allowNoTextSkip: !collectPageContext && allowOcrNoTextSkip(run.baseOptions),
  });
  throwIfAborted(signal);
  const timedPrepassNoTextPages = filtered.prepassNoTextPages.map((entry) => ({
    ...entry,
    page: timing.applyTranslationTiming(entry.page),
  }));
  for (const entry of timedPrepassNoTextPages) {
    filtered.completedPagesById.set(entry.page.id, entry.page);
  }
  const approvedPrepassPageIds = await completePrepassNoTextPages({
    context: run.progressContext,
    onPageComplete,
    onPagesComplete,
    prepassNoTextPages: timedPrepassNoTextPages,
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
    cumulativeContextDetail,
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
    timing,
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

type CompleteWholePageRunOptions = Pick<
  PipelineOptions,
  | "blockMode"
  | "canonicalPageIndexById"
  | "collectPageContext"
  | "cumulativeContextDetail"
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
  timing: PageProcessingTimingCollector;
};

async function completeWholePageRun({
  blockMode,
  canonicalPageIndexById,
  collectPageContext,
  cumulativeContextDetail,
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
  timing,
}: CompleteWholePageRunOptions): Promise<WholePagePipelineResult> {
  throwIfAborted(signal);
  if (filtered.pagesToTranslate.length === 0) {
    emitPagesReadyWithoutModel(run.progressContext, pages.length);
    return buildPipelineResult(pages, filtered, warningCollector);
  }
  const endpoint = await measureSharedProcessingStage(timing, "preparing", () =>
    startWholePageEndpoint({ onCleanupReady, run }),
  );
  let preparedPages: PreparedChapterPages;
  try {
    preparedPages = await prepareTranslatedPages({
      endpoint,
      filtered,
      ocrHintsByPageId,
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
      cumulativeContextDetail: cumulativeContextDetail ?? "detailed",
      canonicalPageIndexById,
      dependencies,
      timing,
    });
  } finally {
    await endpoint.disposeEndpointSession();
  }
  throwIfAborted(signal);
  await finalizeTranslatedPages({
    preparedPages,
    filtered,
    ocrHintsByPageId,
    onPageComplete,
    run,
    signal,
    warningCollector,
    workContext,
    writeStoryMemory: writeStoryMemory ?? true,
    collectPageContext: collectPageContext ?? false,
    cumulativeContextDetail: cumulativeContextDetail ?? "detailed",
    dependencies,
    timing,
  });
  emitFinalizing(
    run.progressContext,
    tMain("translation.progress.pagesReady", { count: pages.length }),
  );
  return buildPipelineResult(pages, filtered, warningCollector);
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
): WholePagePipelineResult {
  const completedPages = buildPipelinePages(pages, filtered.completedPagesById);
  const failureGuidance = warningCollector.resolveTerminalFailureGuidance();
  return {
    pages: completedPages,
    warnings: warningCollector.warnings,
    ...(failureGuidance ? { failureGuidance } : {}),
  };
}

async function prepareWholePageRun(
  options: PipelineOptions,
  dependencies: WholePagePipelineDependencies,
  injected: boolean,
  timing: PageProcessingTimingCollector,
): Promise<{
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
}> {
  // Download the externalized font matching runtime bundle (excluded from the
  // installer; see electron-builder.config.cjs `font-matching/**` filter) into
  // the writable data-root cache before configureWholePageOutputOptions (the
  // first loadCandidates call). No-op for injected deps (tests) and when auto
  // font matching is off; non-abort failures degrade fail-closed.
  await measureSharedProcessingStage(timing, "preparing", () =>
    prepareFontMatchingRuntimeForRun(options, dependencies.paths, injected),
  );
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
  const run = await measureSharedProcessingStage(timing, "preparing", () =>
    prepareAnalysisRun({
      jobId,
      emit,
      pages,
      runPaths,
      runtime: dependencies.runtime,
      signal,
      skipOcrPrepass,
      dependencies,
    }),
  );
  throwIfAborted(signal);
  const ocrHintsByPageId = await measureSharedProcessingStage(
    timing,
    "ocr",
    () =>
      preparePageOcrHints({
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
      }),
  );
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

type PreparedChapterPage = Readonly<{
  page: MangaPage;
  pageIndex: number;
  progressPageIndex: number;
  prepared: PreparedPageBuildResult;
}>;

type PreparedChapterPages = Readonly<{
  entries: readonly PreparedChapterPage[];
  fontMatchingChapterCoordinator?: ReturnType<
    typeof createAutomaticFontChapterCoordinatorV2
  >;
}>;

const previewPageContextDependencies: PageContextPersistenceDependencies = {
  repository: {
    saveChapterStoryMemory: (memory) => Promise.resolve(memory),
    saveWorkStyleGuide: (guide) => Promise.resolve(guide),
  },
  logger: { warn: logPipelineWarning },
};

// eslint-disable-next-line max-lines-per-function -- page sequencing owns one shared endpoint session
async function prepareTranslatedPages({
  endpoint,
  filtered,
  ocrHintsByPageId,
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
  cumulativeContextDetail,
  canonicalPageIndexById,
  dependencies,
  timing,
}: {
  endpoint: AnalysisEndpointSession;
  filtered: ReturnType<typeof filterPagesByOcrText>;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
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
  cumulativeContextDetail: NonNullable<
    PipelineOptions["cumulativeContextDetail"]
  >;
  canonicalPageIndexById?: PipelineOptions["canonicalPageIndexById"];
  dependencies: WholePagePipelineDependencies;
  timing: PageProcessingTimingCollector;
}): Promise<PreparedChapterPages> {
  const fontMatchingChapterCoordinator = run.baseOptions.autoFontMatching
    ? createAutomaticFontChapterCoordinatorV2()
    : undefined;
  const rollingWorkContext = workContext
    ? structuredClone(workContext)
    : undefined;
  const rollingWarningCollector = createWarningCollector();
  const entries: PreparedChapterPage[] = [];
  for (const page of filtered.pagesToTranslate) {
    const progressPageIndex = filtered.pageIndexById.get(page.id) ?? 0;
    const pageIndex = canonicalPageIndexById?.get(page.id) ?? progressPageIndex;
    throwIfAborted(signal);
    const prepared = await preparePageWithRetries({
      baseOptions: run.baseOptions,
      completedPagesById: filtered.completedPagesById,
      context: run.progressContext,
      maxAttempts: endpoint.maxAttempts,
      ocrHintsByPageId,
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
      workContext: rollingWorkContext,
      regionContext,
      collectPageContext,
      cumulativeContextDetail,
      diagnostics: dependencies.diagnostics,
      timing,
    });
    if (prepared) {
      entries.push({ page, pageIndex, progressPageIndex, prepared });
      if (writeStoryMemory && rollingWorkContext) {
        await persistPageContextAfterSuccess(
          {
            page: projectPreparedPageForContext(prepared),
            pageIndex,
            pageContext:
              prepared.kind === "ready"
                ? prepared.result.pageContext
                : prepared.pageContext,
            ocrResult: ocrHintsByPageId.get(page.id),
            collectPageContext,
            cumulativeContextDetail,
            warningCollector: rollingWarningCollector,
            workContext: rollingWorkContext,
          },
          previewPageContextDependencies,
        );
      }
    }
  }
  return { entries, fontMatchingChapterCoordinator };
}

async function finalizeTranslatedPages({
  preparedPages,
  filtered,
  ocrHintsByPageId,
  onPageComplete,
  run,
  signal,
  warningCollector,
  workContext,
  writeStoryMemory,
  collectPageContext,
  cumulativeContextDetail,
  dependencies,
  timing,
}: {
  preparedPages: PreparedChapterPages;
  filtered: ReturnType<typeof filterPagesByOcrText>;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  onPageComplete?: PipelineOptions["onPageComplete"];
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
  signal: AbortSignal;
  warningCollector: ReturnType<typeof createWarningCollector>;
  workContext?: PipelineOptions["workContext"];
  writeStoryMemory: boolean;
  collectPageContext: boolean;
  cumulativeContextDetail: NonNullable<
    PipelineOptions["cumulativeContextDetail"]
  >;
  dependencies: WholePagePipelineDependencies;
  timing: PageProcessingTimingCollector;
}): Promise<void> {
  for (const entry of preparedPages.entries) {
    throwIfAborted(signal);
    const completed = await completePreparedPageTranslationAttempt({
      context: run.progressContext,
      onPageComplete,
      page: entry.page,
      pageIndex: entry.progressPageIndex,
      prepared: entry.prepared,
      warningCollector,
      fontMatchingPageInference: dependencies.fontMatching.pageInference,
      fontMatchingChapterCoordinator:
        preparedPages.fontMatchingChapterCoordinator,
      timing,
    });
    filtered.completedPagesById.set(entry.page.id, completed.page);
    if (writeStoryMemory && completed.approved) {
      await persistPageContextAfterSuccess(
        {
          page: completed.page,
          pageIndex: entry.pageIndex,
          pageContext: completed.pageContext,
          ocrResult: ocrHintsByPageId.get(entry.page.id),
          collectPageContext,
          cumulativeContextDetail,
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
