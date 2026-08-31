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
  buildPageIndexById,
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
import {
  approvePreparedTranslationCheckpoint,
  requireTranslationEndpoint,
  resolveReusableTranslationCheckpoints,
  restoreTranslationCheckpointForRun,
} from "./pipeline/wholePageCheckpointFlow";
import { hydrateFontContinuityBeforePage } from "./pipeline/wholePageFontContinuity";

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
    onPagePrepared,
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
    fontContinuityPages,
  } = options;
  const timing =
    options.timing ??
    createPageProcessingTimingCollector(
      options.jobId,
      pages.map((page) => page.id),
    );
  throwIfAborted(signal);
  const { ocrHintsByPageId, reusableCheckpoints, run } =
    await prepareWholePageRun(
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

  const modelPages = pages.filter((page) => !reusableCheckpoints.has(page.id));
  const filtered = filterPagesByOcrText(modelPages, ocrHintsByPageId, {
    allowNoTextSkip: !collectPageContext && allowOcrNoTextSkip(run.baseOptions),
  });
  filtered.pageIndexById = buildPageIndexById(pages);
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
    onPagePrepared,
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
    reusableCheckpoints,
    fontContinuityPages,
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
  | "onPagePrepared"
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
  reusableCheckpoints: NonNullable<PipelineOptions["translationCheckpoints"]>;
  fontContinuityPages?: readonly MangaPage[];
};

async function completeWholePageRun(
  options: CompleteWholePageRunOptions,
): Promise<WholePagePipelineResult> {
  const {
    filtered,
    pages,
    reusableCheckpoints,
    run,
    signal,
    warningCollector,
  } = options;
  throwIfAborted(signal);
  if (
    filtered.pagesToTranslate.length === 0 &&
    reusableCheckpoints.size === 0
  ) {
    emitPagesReadyWithoutModel(run.progressContext, pages.length);
    return buildPipelineResult(pages, filtered, warningCollector);
  }
  const preparedPages = await preparePagesWithinEndpointSession(options);
  throwIfAborted(signal);
  await finalizeTranslatedPages({
    preparedPages,
    filtered,
    ocrHintsByPageId: options.ocrHintsByPageId,
    onPageComplete: options.onPageComplete,
    run,
    signal,
    warningCollector,
    workContext: options.workContext,
    writeStoryMemory: options.writeStoryMemory ?? true,
    collectPageContext: options.collectPageContext ?? false,
    cumulativeContextDetail: options.cumulativeContextDetail ?? "detailed",
    dependencies: options.dependencies,
    timing: options.timing,
    fontContinuityPages: options.fontContinuityPages,
  });
  emitFinalizing(
    run.progressContext,
    tMain("translation.progress.pagesReady", { count: pages.length }),
  );
  return buildPipelineResult(pages, filtered, warningCollector);
}

async function preparePagesWithinEndpointSession(
  options: CompleteWholePageRunOptions,
): Promise<PreparedChapterPages> {
  const endpoint =
    options.filtered.pagesToTranslate.length > 0
      ? await measureSharedProcessingStage(options.timing, "preparing", () =>
          startWholePageEndpoint({
            onCleanupReady: options.onCleanupReady,
            run: options.run,
          }),
        )
      : undefined;
  if (!endpoint) {
    emitPagesReadyWithoutModel(
      options.run.progressContext,
      options.pages.length,
    );
  }
  try {
    return await prepareTranslatedPages({
      ...options,
      endpoint,
      writeStoryMemory: options.writeStoryMemory ?? true,
      collectPageContext: options.collectPageContext ?? false,
      cumulativeContextDetail: options.cumulativeContextDetail ?? "detailed",
    });
  } finally {
    await endpoint?.disposeEndpointSession();
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
  reusableCheckpoints: NonNullable<PipelineOptions["translationCheckpoints"]>;
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
  const reusableCheckpoints = resolveReusableTranslationCheckpoints(
    pages,
    options.translationCheckpoints,
    run.baseOptions,
    blockMode,
    (message, details) => dependencies.diagnostics.warn(message, details),
  );
  const modelPages = pages.filter((page) => !reusableCheckpoints.has(page.id));
  const ocrHintsByPageId = await measureSharedProcessingStage(
    timing,
    "ocr",
    () =>
      preparePageOcrHints({
        jobId,
        pages: modelPages,
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
  return { ocrHintsByPageId, reusableCheckpoints, run };
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

type PrepareTranslatedPagesOptions = {
  endpoint?: AnalysisEndpointSession;
  filtered: ReturnType<typeof filterPagesByOcrText>;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  onPageFailed?: PipelineOptions["onPageFailed"];
  onPagePrepared?: PipelineOptions["onPagePrepared"];
  pages: MangaPage[];
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
  reusableCheckpoints: NonNullable<PipelineOptions["translationCheckpoints"]>;
};

async function prepareTranslatedPages(
  options: PrepareTranslatedPagesOptions,
): Promise<PreparedChapterPages> {
  const fontMatchingChapterCoordinator = options.run.baseOptions
    .autoFontMatching
    ? createAutomaticFontChapterCoordinatorV2()
    : undefined;
  const rollingWorkContext = options.workContext
    ? structuredClone(options.workContext)
    : undefined;
  const rollingWarningCollector = createWarningCollector();
  const entries: PreparedChapterPage[] = [];
  const modelPageIds = new Set(
    options.filtered.pagesToTranslate.map((page) => page.id),
  );
  for (const page of options.pages) {
    const entry = await prepareTranslatedPageEntry(
      page,
      modelPageIds,
      rollingWorkContext,
      options,
    );
    if (!entry) continue;
    if (!options.reusableCheckpoints.has(page.id)) {
      await approvePreparedTranslationCheckpoint({
        blockMode: options.blockMode,
        onPagePrepared: options.onPagePrepared,
        page,
        prepared: entry.prepared,
        run: options.run,
        timing: options.timing,
      });
    }
    entries.push(entry);
    await persistPreparedPageContext(
      entry,
      rollingWorkContext,
      rollingWarningCollector,
      options,
    );
  }
  return { entries, fontMatchingChapterCoordinator };
}

async function prepareTranslatedPageEntry(
  page: MangaPage,
  modelPageIds: ReadonlySet<string>,
  rollingWorkContext: PipelineOptions["workContext"],
  options: PrepareTranslatedPagesOptions,
): Promise<PreparedChapterPage | undefined> {
  const checkpoint = options.reusableCheckpoints.get(page.id);
  if (!checkpoint && !modelPageIds.has(page.id)) return undefined;
  const progressPageIndex = options.filtered.pageIndexById.get(page.id) ?? 0;
  const pageIndex =
    options.canonicalPageIndexById?.get(page.id) ?? progressPageIndex;
  throwIfAborted(options.signal);
  const prepared = checkpoint
    ? restoreTranslationCheckpointForRun({
        blockMode: options.blockMode,
        checkpoint,
        collectPageContext: options.collectPageContext,
        cumulativeContextDetail: options.cumulativeContextDetail,
        ocrHintsByPageId: options.ocrHintsByPageId,
        page,
        pageIndex,
        progressPageIndex,
        regionContext: options.regionContext,
        run: options.run,
        signal: options.signal,
        timing: options.timing,
        workContext: rollingWorkContext,
      })
    : await prepareModelPage({
        ...options,
        page,
        pageIndex,
        progressPageIndex,
        workContext: rollingWorkContext,
      });
  return prepared
    ? { page, pageIndex, progressPageIndex, prepared }
    : undefined;
}

async function persistPreparedPageContext(
  entry: PreparedChapterPage,
  workContext: PipelineOptions["workContext"],
  warningCollector: ReturnType<typeof createWarningCollector>,
  options: PrepareTranslatedPagesOptions,
): Promise<void> {
  if (!options.writeStoryMemory || !workContext) return;
  await persistPageContextAfterSuccess(
    {
      page: projectPreparedPageForContext(entry.prepared),
      pageIndex: entry.pageIndex,
      pageContext:
        entry.prepared.kind === "ready"
          ? entry.prepared.result.pageContext
          : entry.prepared.pageContext,
      ocrResult: options.ocrHintsByPageId.get(entry.page.id),
      collectPageContext: options.collectPageContext,
      cumulativeContextDetail: options.cumulativeContextDetail,
      warningCollector,
      workContext,
    },
    previewPageContextDependencies,
  );
}

async function prepareModelPage({
  blockMode,
  collectPageContext,
  cumulativeContextDetail,
  dependencies,
  endpoint,
  filtered,
  ocrHintsByPageId,
  onPageFailed,
  page,
  pageIndex,
  progressPageIndex,
  regionContext,
  run,
  runPaths,
  signal,
  skipOcrPrepass,
  timing,
  warningCollector,
  workContext,
}: {
  blockMode?: PipelineOptions["blockMode"];
  collectPageContext: boolean;
  cumulativeContextDetail: NonNullable<
    PipelineOptions["cumulativeContextDetail"]
  >;
  dependencies: WholePagePipelineDependencies;
  endpoint?: AnalysisEndpointSession;
  filtered: ReturnType<typeof filterPagesByOcrText>;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  onPageFailed?: PipelineOptions["onPageFailed"];
  page: MangaPage;
  pageIndex: number;
  progressPageIndex: number;
  regionContext?: PipelineOptions["regionContext"];
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
  runPaths: PipelineOptions["runPaths"];
  signal: AbortSignal;
  skipOcrPrepass: boolean;
  timing: PageProcessingTimingCollector;
  warningCollector: ReturnType<typeof createWarningCollector>;
  workContext?: PipelineOptions["workContext"];
}): Promise<PreparedPageBuildResult | null> {
  return preparePageWithRetries({
    baseOptions: run.baseOptions,
    completedPagesById: filtered.completedPagesById,
    context: run.progressContext,
    maxAttempts: requireTranslationEndpoint(endpoint).maxAttempts,
    ocrHintsByPageId,
    onPageFailed,
    page,
    pageIndex,
    progressPageIndex,
    runPaths,
    runtime: run.runtime,
    server: requireTranslationEndpoint(endpoint).server,
    signal,
    skipOcrPrepass,
    blockMode,
    warningCollector,
    workContext,
    regionContext,
    collectPageContext,
    cumulativeContextDetail,
    diagnostics: dependencies.diagnostics,
    timing,
  });
}

type FinalizeTranslatedPagesOptions = {
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
  fontContinuityPages?: readonly MangaPage[];
};

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
  fontContinuityPages,
}: FinalizeTranslatedPagesOptions): Promise<void> {
  const selectedPageIds = new Set(
    preparedPages.entries.map((entry) => entry.page.id),
  );
  let continuityCursor = 0;
  for (const entry of preparedPages.entries) {
    throwIfAborted(signal);
    continuityCursor = await hydrateFontContinuityBeforePage({
      coordinator: preparedPages.fontMatchingChapterCoordinator,
      pages: fontContinuityPages,
      beforePageId: entry.page.id,
      startIndex: continuityCursor,
      selectedPageIds,
      candidates: run.baseOptions.fontMatchingCandidates,
      pageInference: dependencies.fontMatching.pageInference,
      targetLanguage: run.baseOptions.targetLanguage,
      signal,
      dependencies,
    });
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
