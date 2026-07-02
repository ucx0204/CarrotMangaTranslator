import type { MangaPage } from "../shared/types";
import { logInfo } from "./logger";
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
import { prepareKeepBlockHints } from "./pipeline/keepBlocksOcr";
import {
  buildKeepBlocksOcrResult,
  shouldKeepExistingBlocks,
} from "./pipeline/keepBlocksResult";
import { prepareOcrHintsForPages } from "./pipeline/ocrHints";
import { formatGemmaVramMode } from "./pipeline/options";
import { prepareAnalysisRun } from "./pipeline/prepareAnalysisRun";
import { emitFinalizing } from "./pipeline/progressEvents";
import { translatePageWithRetries } from "./pipeline/translatePageWithRetries";
import type { OcrBboxResult, PipelineOptions } from "./pipeline/types";
import { prepareRegionContextOcrHints } from "./pipeline/regionOcrContext";
import { createWarningCollector } from "./pipeline/warningCollector";
import {
  buildPageStoryMemory,
  upsertPageStoryMemory,
} from "./pipeline/storyMemoryBuilder";
import { writeChapterStoryMemory } from "./libraryStore/workContextFiles";

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
}: PipelineOptions): Promise<{ pages: MangaPage[]; warnings: string[] }> {
  if (pages.length === 0) {
    return { pages: [], warnings: [] };
  }

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

  const filtered = filterPagesByOcrText(pages, ocrHintsByPageId);
  await completePrepassNoTextPages({
    context: run.progressContext,
    onPageComplete,
    onPagesComplete,
    prepassNoTextPages: filtered.prepassNoTextPages,
  });

  if (filtered.pagesToTranslate.length === 0) {
    emitFinalizing(
      run.progressContext,
      `${pages.length} pages ready, 모델 호출 없음`,
    );
    return buildPipelineResult(pages, filtered, warningCollector);
  }

  const endpoint = await startWholePageEndpoint({
    onCleanupReady,
    run,
  });

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
      writeStoryMemory,
    });
    emitFinalizing(run.progressContext, `${pages.length} pages ready`);
    return buildPipelineResult(pages, filtered, warningCollector);
  } finally {
    await endpoint.disposeEndpointSession();
  }
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

async function preparePageOcrHints({
  jobId,
  pages,
  run,
  runPaths,
  signal,
  skipOcrPrepass,
  blockMode,
  decodeImage,
  regionContext,
}: {
  jobId: string;
  pages: MangaPage[];
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
  runPaths: PipelineOptions["runPaths"];
  signal: AbortSignal;
  skipOcrPrepass: boolean;
  blockMode?: PipelineOptions["blockMode"];
  decodeImage?: PipelineOptions["decodeImage"];
  regionContext?: PipelineOptions["regionContext"];
}): Promise<Map<string, OcrBboxResult>> {
  if (regionContext) {
    return prepareRegionContextOcrHints({
      runtime: run.runtime,
      baseOptions: run.baseOptions,
      emit: run.progressContext.emit,
      jobId,
      pages,
      regionContext,
      runPaths,
      signal,
    });
  }
  if (skipOcrPrepass) {
    logInfo("OCR prepass skipped for analysis pipeline", {
      jobId,
      pageCount: pages.length,
    });
    return new Map<string, OcrBboxResult>(
      pages
        .filter((page) => shouldKeepExistingBlocks(blockMode, page))
        .map((page) => [page.id, buildKeepBlocksOcrResult(page)]),
    );
  }
  const keepBlockHints = await prepareKeepBlockHints({
    runtime: run.runtime,
    baseOptions: run.baseOptions,
    keepPages: pages.filter((page) =>
      shouldKeepExistingBlocks(blockMode, page),
    ),
    pageCount: pages.length,
    runPaths,
    emit: run.progressContext.emit,
    jobId,
    signal,
    decodeImage,
  });
  const prepassPages = pages.filter((page) => !keepBlockHints.has(page.id));
  if (prepassPages.length === 0) {
    return keepBlockHints;
  }
  const prepassHints = await prepareOcrHintsForPages({
    runtime: run.runtime,
    baseOptions: run.baseOptions,
    pages: prepassPages,
    runPaths,
    emit: run.progressContext.emit,
    jobId,
    signal,
  });
  return new Map([...keepBlockHints, ...prepassHints]);
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
}): Promise<void> {
  for (const page of filtered.pagesToTranslate) {
    const pageIndex = filtered.pageIndexById.get(page.id) ?? 0;
    throwIfAborted(signal);
    await translatePageWithRetries({
      baseOptions: run.baseOptions,
      completedPagesById: filtered.completedPagesById,
      context: run.progressContext,
      maxAttempts: endpoint.maxAttempts,
      ocrHintsByPageId,
      onPageComplete,
      onPageFailed,
      page,
      pageIndex,
      runPaths,
      runtime: run.runtime,
      server: endpoint.server,
      signal,
      skipOcrPrepass,
      blockMode,
      warningCollector,
      workContext,
      regionContext,
    });
    if (writeStoryMemory) {
      await updateStoryMemoryAfterPage({
        completedPagesById: filtered.completedPagesById,
        pageId: page.id,
        pageIndex,
        workContext,
      });
    }
  }
}

async function updateStoryMemoryAfterPage({
  completedPagesById,
  pageId,
  pageIndex,
  workContext,
}: {
  completedPagesById: Map<string, MangaPage>;
  pageId: string;
  pageIndex: number;
  workContext?: PipelineOptions["workContext"];
}): Promise<void> {
  if (!workContext) {
    return;
  }
  const completedPage = completedPagesById.get(pageId);
  if (!completedPage || completedPage.analysisStatus !== "completed") {
    return;
  }
  workContext.storyMemory = upsertPageStoryMemory(
    workContext.storyMemory,
    buildPageStoryMemory({ page: completedPage, pageIndex }),
  );
  workContext.storyMemory = await writeChapterStoryMemory(
    workContext.storyMemory,
  );
}
