import type { TranslationOptions } from "../appSettings";
import type { ChapterRunPaths } from "../library";
import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { throwIfAborted } from "./failure";
import { isOcrResultNoTextDetected } from "./noText";
import {
  buildOcrPageOptions,
  getOcrHintsCachePath,
  readCachedOcrHints,
  removeStaleAnimeTextEvidence,
  writeCachedOcrHints,
} from "./ocrHintsCache";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import type { OcrBboxResult } from "./types";
import { tMain } from "./localization";
import { isHayaiOcrPipeline } from "../../shared/ocrEngines";

type PrepareOcrHintsOptions = {
  runtime: Pick<
    TranslationRuntimePort,
    "annotateOcrGroupingEvidenceBatch" | "collectOcrHintsBatch"
  >;
  baseOptions: TranslationOptions;
  pages: MangaPage[];
  runPaths: ChapterRunPaths;
  emit: (event: JobEvent) => void;
  jobId: string;
  signal: AbortSignal;
};

type PendingOcrPage = {
  page: MangaPage;
  index: number;
  options: TranslationOptions;
  cachePath: string;
};

type PendingGroupingEvidencePage = PendingOcrPage & {
  cachedResult: OcrBboxResult;
};

type OcrHintsProgressContext = PrepareOcrHintsOptions & {
  results: Map<string, OcrBboxResult>;
  total: number;
};

export async function prepareOcrHintsForPages({
  runtime,
  baseOptions,
  pages,
  runPaths,
  emit,
  jobId,
  signal,
}: PrepareOcrHintsOptions): Promise<Map<string, OcrBboxResult>> {
  const results = new Map<string, OcrBboxResult>();
  const progressContext = {
    baseOptions,
    emit,
    jobId,
    pages,
    results,
    runPaths,
    runtime,
    signal,
    total: pages.length,
  } satisfies OcrHintsProgressContext;
  const pending = await collectPendingOcrPages(progressContext);
  await refreshPendingGroupingEvidenceBatch(
    progressContext,
    pending.groupingEvidencePages,
  );
  await collectPendingOcrHintsBatch(progressContext, pending.ocrPages);
  emitOcrHintsCompleted(progressContext);
  return results;
}

async function collectPendingOcrPages(
  progressContext: OcrHintsProgressContext,
): Promise<{
  ocrPages: PendingOcrPage[];
  groupingEvidencePages: PendingGroupingEvidencePage[];
}> {
  const { baseOptions, pages, results, runPaths, signal, total } =
    progressContext;
  const ocrPages: PendingOcrPage[] = [];
  const groupingEvidencePages: PendingGroupingEvidencePage[] = [];
  for (const [index, page] of pages.entries()) {
    throwIfAborted(signal);
    const cachePath = getOcrHintsCachePath(runPaths, page);
    const cached = await readCachedOcrHints(cachePath, page, baseOptions);
    if (cached) {
      if (!cached.requiresGroupingEvidenceRefresh) {
        results.set(page.id, cached.result);
        emitCachedOcrHintProgress(
          progressContext,
          page,
          index,
          total,
          cached.result,
        );
      } else {
        groupingEvidencePages.push({
          page,
          index,
          options: buildPendingOcrPageOptions(
            progressContext,
            page,
            index,
            total,
          ),
          cachePath,
          cachedResult: removeStaleAnimeTextEvidence(cached.result),
        });
      }
      continue;
    }

    ocrPages.push({
      page,
      index,
      options: buildPendingOcrPageOptions(progressContext, page, index, total),
      cachePath,
    });
  }
  return { ocrPages, groupingEvidencePages };
}

function buildPendingOcrPageOptions(
  progressContext: OcrHintsProgressContext,
  page: MangaPage,
  index: number,
  total: number,
): TranslationOptions {
  const options = buildOcrPageOptions(
    progressContext.baseOptions,
    page,
    progressContext.runPaths,
    index,
    total,
  );
  options.abortSignal = progressContext.signal;
  options.onProgress = createOcrPageProgressHandler({
    index,
    options,
    progressContext,
  });
  return options;
}

function emitCachedOcrHintProgress(
  {
    baseOptions,
    emit,
    jobId,
  }: Pick<OcrHintsProgressContext, "baseOptions" | "emit" | "jobId">,
  page: MangaPage,
  index: number,
  total: number,
  cached: OcrBboxResult,
): void {
  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain("ocr.cached", { page: page.name }),
    phase: "ocr_running",
    ocrPipeline: baseOptions.ocrPipeline,
    progressCurrent: index + 1,
    progressTotal: total,
    pageIndex: index + 1,
    pageTotal: total,
    detail: formatOcrHintDetail(cached),
  });
}

function createOcrPageProgressHandler({
  index,
  options,
  progressContext,
}: {
  index: number;
  options: TranslationOptions;
  progressContext: OcrHintsProgressContext;
}): NonNullable<TranslationOptions["onProgress"]> {
  return (progress) => {
    const hasExplicitPageProgress =
      Number.isFinite(progress.pageIndex) &&
      Number.isFinite(progress.pageTotal);
    const suppressDefaultPageProgress =
      progress.pageIndex === null || progress.pageTotal === null;
    const shouldDefaultToPage =
      Boolean(options.ocrProgressDefaultToPage) && !suppressDefaultPageProgress;
    progressContext.emit({
      id: progressContext.jobId,
      kind: "gemma-analysis",
      status: "running",
      progressText: progress.progressText,
      phase: progress.phase,
      ocrPipeline: progressContext.baseOptions.ocrPipeline,
      progressCurrent:
        progress.progressCurrent ??
        (shouldDefaultToPage ? index + 1 : progressContext.results.size),
      progressTotal: progress.progressTotal ?? progressContext.total,
      pageIndex: hasExplicitPageProgress
        ? Number(progress.pageIndex)
        : shouldDefaultToPage
          ? index + 1
          : undefined,
      pageTotal: hasExplicitPageProgress
        ? Number(progress.pageTotal)
        : shouldDefaultToPage
          ? progressContext.total
          : undefined,
      detail: progress.detail,
      progressMode: progress.progressMode,
      progressPercent: progress.progressPercent,
      progressBytes: progress.progressBytes,
      progressTotalBytes: progress.progressTotalBytes,
      progressBytesPerSecond: progress.progressBytesPerSecond,
      installLogLine: progress.installLogLine,
    });
  };
}

async function collectPendingOcrHintsBatch(
  progressContext: OcrHintsProgressContext,
  pendingPages: PendingOcrPage[],
): Promise<void> {
  if (pendingPages.length === 0) {
    return;
  }
  preparePendingOcrBatchOptions(progressContext, pendingPages);
  emitOcrBatchStarted(progressContext, pendingPages.length);
  const batchResults = await progressContext.runtime.collectOcrHintsBatch(
    pendingPages.map((entry) => entry.options),
  );
  for (const [batchIndex, result] of batchResults.entries()) {
    throwIfAborted(progressContext.signal);
    const entry = pendingPages[batchIndex];
    if (entry) {
      await saveOcrBatchResult(
        progressContext,
        pendingPages,
        entry,
        batchIndex,
        result,
      );
    }
  }
}

async function refreshPendingGroupingEvidenceBatch(
  progressContext: OcrHintsProgressContext,
  pendingPages: PendingGroupingEvidencePage[],
): Promise<void> {
  if (pendingPages.length === 0) {
    return;
  }
  preparePendingOcrBatchOptions(progressContext, pendingPages);
  const refreshed =
    await progressContext.runtime.annotateOcrGroupingEvidenceBatch(
      pendingPages.map((entry) => entry.options),
      pendingPages.map((entry) => entry.cachedResult),
    );
  if (refreshed.length !== pendingPages.length) {
    throw new Error(
      "OCR grouping-evidence migration returned an unexpected result count.",
    );
  }
  for (const [index, result] of refreshed.entries()) {
    throwIfAborted(progressContext.signal);
    const entry = pendingPages[index];
    if (!entry) {
      continue;
    }
    await writeCachedOcrHints(
      entry.cachePath,
      entry.page,
      result,
      entry.options,
    );
    progressContext.results.set(entry.page.id, result);
    emitCachedOcrHintProgress(
      progressContext,
      entry.page,
      entry.index,
      progressContext.total,
      result,
    );
  }
}

function preparePendingOcrBatchOptions(
  { results, total }: OcrHintsProgressContext,
  pendingPages: PendingOcrPage[],
): void {
  pendingPages.forEach((entry) => {
    entry.options.ocrBatchCompletedBefore = results.size;
    entry.options.ocrBatchTotal = total;
  });
}

function emitOcrBatchStarted(
  { baseOptions, emit, jobId, total }: OcrHintsProgressContext,
  pendingCount: number,
): void {
  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain(
      isHayaiOcrPipeline(baseOptions.ocrPipeline)
        ? "ocr.hayaiBatchRunning"
        : "ocr.batchRunning",
    ),
    phase: "ocr_running",
    ocrPipeline: baseOptions.ocrPipeline,
    progressCurrent: 0,
    progressTotal: pendingCount,
    pageTotal: total,
    detail: tMain("ocr.batchRunningDetail", { count: pendingCount }),
  });
}

async function saveOcrBatchResult(
  { baseOptions, emit, jobId, results, total }: OcrHintsProgressContext,
  pendingPages: PendingOcrPage[],
  entry: PendingOcrPage,
  batchIndex: number,
  result: OcrBboxResult,
): Promise<void> {
  await writeCachedOcrHints(entry.cachePath, entry.page, result, entry.options);
  results.set(entry.page.id, result);
  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain("ocr.pageDone", { page: entry.page.name }),
    phase: "ocr_running",
    ocrPipeline: baseOptions.ocrPipeline,
    progressCurrent: batchIndex + 1,
    progressTotal: pendingPages.length,
    pageIndex: entry.index + 1,
    pageTotal: total,
    detail: formatOcrHintDetail(result),
  });
}

function emitOcrHintsCompleted({
  baseOptions,
  emit,
  jobId,
  total,
}: OcrHintsProgressContext): void {
  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain(
      isHayaiOcrPipeline(baseOptions.ocrPipeline)
        ? "ocr.hayaiPrepassDone"
        : "ocr.prepassDone",
    ),
    phase: "ocr_running",
    ocrPipeline: baseOptions.ocrPipeline,
    progressCurrent: total,
    progressTotal: total,
    pageTotal: total,
    detail: tMain("ocr.prepassDoneDetail"),
  });
}

function formatOcrHintDetail(result: OcrBboxResult): string {
  if (isOcrResultNoTextDetected(result)) {
    return tMain("ocr.hintDetailNoEvidence", { count: result.hints.length });
  }
  if (Number.isFinite(result.textEvidenceCount)) {
    return tMain("ocr.hintDetailWithEvidence", {
      count: result.hints.length,
      evidence: result.textEvidenceCount,
    });
  }
  return tMain("ocr.hintDetail", { count: result.hints.length });
}
