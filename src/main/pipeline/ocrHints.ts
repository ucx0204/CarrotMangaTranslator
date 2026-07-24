import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TranslationOptions } from "../appSettings";
import type { ChapterRunPaths } from "../library";
import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  DEFAULT_SOURCE_LANGUAGE,
  normalizeLanguageCode,
} from "../../shared/translationLanguages";
import { throwIfAborted } from "./failure";
import { isOcrResultNoTextDetected } from "./noText";
import {
  buildOcrCacheConfiguration,
  matchesOcrCacheConfiguration,
} from "./ocrHintsCacheConfiguration";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import type { OcrBboxResult } from "./types";
import { tMain } from "./localization";

// Schema 9 adds deterministic axis-v4 review-fragment metadata used by the
// image-aware group-only pass. Older semantic caches must be regenerated:
// treating their legacy Paddle groups as reviewed final groups would lock in
// the exact split/merge regressions this stage is meant to prevent.
const OCR_HINT_CACHE_SCHEMA_VERSION = 9;

type PrepareOcrHintsOptions = {
  runtime: Pick<TranslationRuntimePort, "collectOcrHintsBatch">;
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
  const pendingPages = await collectPendingOcrPages(progressContext);
  await collectPendingOcrHintsBatch(progressContext, pendingPages);
  emitOcrHintsCompleted(progressContext);
  return results;
}

async function collectPendingOcrPages(
  progressContext: OcrHintsProgressContext,
): Promise<PendingOcrPage[]> {
  const { baseOptions, pages, results, runPaths, signal, total } =
    progressContext;
  const pendingPages: PendingOcrPage[] = [];
  for (const [index, page] of pages.entries()) {
    throwIfAborted(signal);
    const cachePath = getOcrHintsCachePath(runPaths, page);
    const cached = await readCachedOcrHints(cachePath, page, baseOptions);
    if (cached) {
      results.set(page.id, cached);
      emitCachedOcrHintProgress(progressContext, page, index, total, cached);
      continue;
    }

    const ocrOptions = buildOcrPageOptions(
      baseOptions,
      page,
      runPaths,
      index,
      total,
    );
    ocrOptions.abortSignal = signal;
    ocrOptions.onProgress = createOcrPageProgressHandler({
      index,
      options: ocrOptions,
      progressContext: { ...progressContext, results, total },
    });
    pendingPages.push({ page, index, options: ocrOptions, cachePath });
  }
  return pendingPages;
}

function emitCachedOcrHintProgress(
  { emit, jobId }: Pick<OcrHintsProgressContext, "emit" | "jobId">,
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
  { emit, jobId, total }: OcrHintsProgressContext,
  pendingCount: number,
): void {
  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain("ocr.batchRunning"),
    phase: "ocr_running",
    progressCurrent: 0,
    progressTotal: pendingCount,
    pageTotal: total,
    detail: tMain("ocr.batchRunningDetail", { count: pendingCount }),
  });
}

async function saveOcrBatchResult(
  { emit, jobId, results, total }: OcrHintsProgressContext,
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
    progressCurrent: batchIndex + 1,
    progressTotal: pendingPages.length,
    pageIndex: entry.index + 1,
    pageTotal: total,
    detail: formatOcrHintDetail(result),
  });
}

function emitOcrHintsCompleted({
  emit,
  jobId,
  total,
}: OcrHintsProgressContext): void {
  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain("ocr.prepassDone"),
    phase: "ocr_running",
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

function buildOcrPageOptions(
  baseOptions: TranslationOptions,
  page: MangaPage,
  runPaths: ChapterRunPaths,
  index: number,
  total: number,
): TranslationOptions {
  const outputDir = getOcrHintsOutputDir(runPaths, page);
  return {
    ...baseOptions,
    imagePath: page.imagePath,
    imageWidth: page.width,
    imageHeight: page.height,
    outputDir,
    label: `ocr-page-${index + 1}`,
    ocrPageIndex: index + 1,
    ocrPageTotal: total,
    ocrProgressDefaultToPage: true,
  };
}

function getOcrHintsOutputDir(
  runPaths: ChapterRunPaths,
  page: MangaPage,
): string {
  return join(runPaths.chapterDir, "ocr-hints", page.id);
}

function getOcrHintsCachePath(
  runPaths: ChapterRunPaths,
  page: MangaPage,
): string {
  return join(getOcrHintsOutputDir(runPaths, page), "result.json");
}

async function readCachedOcrHints(
  cachePath: string,
  page: MangaPage,
  options: TranslationOptions,
): Promise<OcrBboxResult | null> {
  try {
    const raw = JSON.parse(await readFile(cachePath, "utf8")) as {
      schemaVersion?: number;
      imagePath?: string;
      width?: number;
      height?: number;
      sourceLanguage?: string;
      configuration?: unknown;
      hints?: unknown[];
      diagnostics?: unknown[];
      noTextDetected?: boolean;
      textEvidenceCount?: number;
    };
    if (
      raw.schemaVersion !== OCR_HINT_CACHE_SCHEMA_VERSION ||
      raw.imagePath !== page.imagePath ||
      raw.width !== page.width ||
      raw.height !== page.height ||
      raw.sourceLanguage !==
        normalizeOcrCacheLanguage(options.sourceLanguage) ||
      !matchesOcrCacheConfiguration(raw.configuration, options) ||
      !Array.isArray(raw.hints)
    ) {
      return null;
    }
    return {
      hints: raw.hints,
      diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics : [],
      noTextDetected: Boolean(raw.noTextDetected),
      textEvidenceCount: Number.isFinite(raw.textEvidenceCount)
        ? Number(raw.textEvidenceCount)
        : undefined,
    };
  } catch (_error) {
    return null;
  }
}

async function writeCachedOcrHints(
  cachePath: string,
  page: MangaPage,
  result: OcrBboxResult,
  options: TranslationOptions,
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    `${JSON.stringify(
      {
        imagePath: page.imagePath,
        width: page.width,
        height: page.height,
        sourceLanguage: normalizeOcrCacheLanguage(options.sourceLanguage),
        configuration: buildOcrCacheConfiguration(options),
        schemaVersion: OCR_HINT_CACHE_SCHEMA_VERSION,
        hints: result.hints,
        diagnostics: result.diagnostics,
        noTextDetected: Boolean(result.noTextDetected),
        textEvidenceCount: Number.isFinite(result.textEvidenceCount)
          ? result.textEvidenceCount
          : undefined,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function normalizeOcrCacheLanguage(sourceLanguage?: string): string {
  return normalizeLanguageCode(sourceLanguage, DEFAULT_SOURCE_LANGUAGE);
}
