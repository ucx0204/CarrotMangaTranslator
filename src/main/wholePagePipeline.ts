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
import { emitFinalizing } from "./pipeline/progressEvents";
import { translatePageWithRetries } from "./pipeline/translatePageWithRetries";
import type { OcrBboxResult, PipelineOptions } from "./pipeline/types";
import { createWarningCollector } from "./pipeline/warningCollector";
import { persistPageContextAfterSuccess } from "./pipeline/pageContextPersistence";
import { preparePageOcrHints } from "./pipeline/pageOcrPreparation";

export async function runWholePagePipeline({
  jobId,
  emit,
  onCleanupReady,
  onPageComplete,
  onPagesComplete,
  onPageFailed,
  pages,
  runPaths,
  signal,
  skipOcrPrepass = false,
  blockMode,
  decodeImage,
  workContext,
  regionContext,
  writeStoryMemory = true,
  collectPageContext = false,
  canonicalPageIndexById,
}: PipelineOptions): Promise<{ pages: MangaPage[]; warnings: string[] }> {
  if (pages.length === 0) return { pages: [], warnings: [] };

  throwIfAborted(signal);
  const { ocrHintsByPageId, run } = await prepareWholePageRun({
    jobId,
    emit,
    pages,
    runPaths,
    signal,
    skipOcrPrepass,
    blockMode,
    decodeImage,
    regionContext,
  });
  const warningCollector = createWarningCollector();
  throwIfAborted(signal);

  const filtered = filterPagesByOcrText(pages, ocrHintsByPageId, {
    allowNoTextSkip: !collectPageContext && allowOcrNoTextSkip(run.baseOptions),
  });
  const approvedPrepassPageIds = await completePrepassNoTextPages({
    context: run.progressContext,
    onPageComplete,
    onPagesComplete,
    prepassNoTextPages: filtered.prepassNoTextPages,
  });
  if (writeStoryMemory && workContext) {
    for (const entry of filtered.prepassNoTextPages) {
      if (!approvedPrepassPageIds.has(entry.page.id)) continue;
      await persistPageContextAfterSuccess({
        page: entry.page,
        pageIndex:
          canonicalPageIndexById?.get(entry.page.id) ?? entry.pageIndex,
        ocrResult: ocrHintsByPageId.get(entry.page.id),
        collectPageContext: false,
        warningCollector,
        workContext,
      });
    }
  }

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
  });
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
}): Promise<{ pages: MangaPage[]; warnings: string[] }> {
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
  emitFinalizing(
    context,
    tMain("translation.progress.pagesReadyNoModel", { count }),
  );
}

/** OCR "텍스트 없음" 스킵은 일본어 원문에서만 허용한다. */
function allowOcrNoTextSkip(baseOptions: { sourceLanguage?: string }): boolean {
  return isJapaneseLanguageCode(baseOptions.sourceLanguage);
}

function buildPipelineResult(
  pages: MangaPage[],
  filtered: ReturnType<typeof filterPagesByOcrText>,
  warningCollector: ReturnType<typeof createWarningCollector>,
): { pages: MangaPage[]; warnings: string[] } {
  return {
    pages: buildPipelinePages(pages, filtered.completedPagesById),
    warnings: warningCollector.warnings,
  };
}

async function prepareWholePageRun({
  jobId,
  emit,
  pages,
  regionContext,
  runPaths,
  signal,
  skipOcrPrepass,
  blockMode,
  decodeImage,
}: Pick<
  PipelineOptions,
  | "blockMode"
  | "decodeImage"
  | "emit"
  | "jobId"
  | "pages"
  | "regionContext"
  | "runPaths"
  | "signal"
> & {
  skipOcrPrepass: boolean;
}): Promise<{
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
}> {
  const run = await prepareAnalysisRun({
    jobId,
    emit,
    pages,
    runPaths,
    signal,
    skipOcrPrepass,
  });
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
  });
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
}): Promise<void> {
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
    });
    if (writeStoryMemory && translated.approved) {
      await persistPageContextAfterSuccess({
        page: filtered.completedPagesById.get(page.id),
        pageIndex,
        pageContext: translated.pageContext,
        ocrResult: ocrHintsByPageId.get(page.id),
        collectPageContext,
        warningCollector,
        workContext,
      });
    }
  }
}
