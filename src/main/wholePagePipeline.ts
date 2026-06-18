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
import { prepareOcrHintsForPages } from "./pipeline/ocrHints";
import { formatGemmaVramMode } from "./pipeline/options";
import { prepareAnalysisRun } from "./pipeline/prepareAnalysisRun";
import { emitFinalizing } from "./pipeline/progressEvents";
import { translatePageWithRetries } from "./pipeline/translatePageWithRetries";
import type { OcrBboxResult, PipelineOptions } from "./pipeline/types";
import { createWarningCollector } from "./pipeline/warningCollector";

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

  const endpoint = await startAnalysisEndpointSession({
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

async function preparePageOcrHints({
  jobId,
  pages,
  run,
  runPaths,
  signal,
  skipOcrPrepass,
}: {
  jobId: string;
  pages: MangaPage[];
  run: Awaited<ReturnType<typeof prepareAnalysisRun>>;
  runPaths: PipelineOptions["runPaths"];
  signal: AbortSignal;
  skipOcrPrepass: boolean;
}): Promise<Map<string, OcrBboxResult>> {
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
    });
  }
}
