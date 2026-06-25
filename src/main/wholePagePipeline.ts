import type { MangaPage } from "../shared/types";
import { logInfo, logWarn } from "./logger";
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
import { prepareOcrHintsForPages } from "./pipeline/ocrHints";
import { formatGemmaVramMode } from "./pipeline/options";
import { prepareAnalysisRun } from "./pipeline/prepareAnalysisRun";
import { emitFinalizing } from "./pipeline/progressEvents";
import { translatePageWithRetries } from "./pipeline/translatePageWithRetries";
import type { OcrBboxResult, PipelineOptions } from "./pipeline/types";
import { mapPageOcrResultToRegionCrop } from "./pipeline/regionOcrContext";
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
  workContext,
  regionContext,
  writeStoryMemory = true,
}: PipelineOptions): Promise<{ pages: MangaPage[]; warnings: string[] }> {
  if (pages.length === 0) {
    return { pages: [], warnings: [] };
  }

  throwIfAborted(signal);
  const run = await prepareAnalysisRun({
    jobId,
    emit,
    pages,
    runPaths,
    signal,
    skipOcrPrepass,
  });
  const warningCollector = createWarningCollector();
  const ocrHintsByPageId = await preparePageOcrHints({
    jobId,
    pages,
    run,
    runPaths,
    signal,
    skipOcrPrepass,
    regionContext,
  });
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
    return {
      pages: buildPipelinePages(pages, filtered.completedPagesById),
      warnings: warningCollector.warnings,
    };
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
      warningCollector,
      workContext,
      regionContext,
      writeStoryMemory,
    });
    emitFinalizing(run.progressContext, `${pages.length} pages ready`);
    return {
      pages: buildPipelinePages(pages, filtered.completedPagesById),
      warnings: warningCollector.warnings,
    };
  } finally {
    await endpoint.disposeEndpointSession();
  }
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
  regionContext,
}: {
  jobId: string;
  pages: MangaPage[];
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
  runPaths: PipelineOptions["runPaths"];
  signal: AbortSignal;
  skipOcrPrepass: boolean;
  regionContext?: PipelineOptions["regionContext"];
}): Promise<Map<string, OcrBboxResult>> {
  if (regionContext) {
    return prepareRegionContextOcrHints({
      jobId,
      pages,
      regionContext,
      run,
      runPaths,
      signal,
    });
  }
  if (skipOcrPrepass) {
    logInfo("OCR prepass skipped for analysis pipeline", {
      jobId,
      pageCount: pages.length,
    });
    return new Map<string, OcrBboxResult>();
  }
  return prepareOcrHintsForPages({
    runtime: run.runtime,
    baseOptions: run.baseOptions,
    pages,
    runPaths,
    emit: run.progressContext.emit,
    jobId,
    signal,
  });
}

async function prepareRegionContextOcrHints({
  jobId,
  pages,
  regionContext,
  run,
  runPaths,
  signal,
}: {
  jobId: string;
  pages: MangaPage[];
  regionContext: NonNullable<PipelineOptions["regionContext"]>;
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
  runPaths: PipelineOptions["runPaths"];
  signal: AbortSignal;
}): Promise<Map<string, OcrBboxResult>> {
  try {
    const sourceResults = await prepareOcrHintsForPages({
      runtime: run.runtime,
      baseOptions: run.baseOptions,
      pages: [regionContext.sourcePage],
      runPaths,
      emit: run.progressContext.emit,
      jobId,
      signal,
    });
    const sourceResult =
      sourceResults.get(regionContext.sourcePage.id) ??
      sourceResults.values().next().value;
    return new Map(
      pages.map((page) => [
        page.id,
        mapPageOcrResultToRegionCrop({
          cropPage: page,
          cropRect: regionContext.cropRect,
          sourceResult,
        }),
      ]),
    );
  } catch (error) {
    logWarn("Region OCR context unavailable; continuing without OCR hints", {
      jobId,
      sourcePageId: regionContext.sourcePage.id,
      error,
    });
    return new Map(
      pages.map((page) => [
        page.id,
        {
          hints: [],
          diagnostics: [
            {
              provider: "region-context",
              reason: "source-ocr-failed",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
          noTextDetected: false,
          textEvidenceCount: 0,
        },
      ]),
    );
  }
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
