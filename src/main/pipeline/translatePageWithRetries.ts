import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/types";
import { logError, logWarn } from "../logger";
import {
  classifyFailure,
  isAbortErrorLike,
  isNonRetriableRuntimeError,
  summarizePage,
  throwIfAborted,
} from "./failure";
import {
  buildFailedPage,
  buildPageResult,
  buildRequestPageOptions,
  requestPageTranslation,
} from "./pageResultBuilder";
import {
  emitNoTextPage,
  emitPageDone,
  emitPageRetry,
  emitPageRunning,
  emitPageSkipped,
  type ProgressContext,
} from "./progressEvents";
import { summarizeTranslationOptions } from "./options";
import type {
  ModelEndpointHandle,
  OcrBboxResult,
  PipelineOptions,
} from "./types";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import type { WarningCollector } from "./warningCollector";
import type { ChapterRunPaths } from "../library";

export async function translatePageWithRetries({
  baseOptions,
  completedPagesById,
  context,
  maxAttempts,
  ocrHintsByPageId,
  onPageComplete,
  onPageFailed,
  page,
  pageIndex,
  runPaths,
  runtime,
  server,
  signal,
  skipOcrPrepass,
  warningCollector,
}: {
  baseOptions: TranslationOptions;
  completedPagesById: Map<string, MangaPage>;
  context: ProgressContext;
  maxAttempts: number;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  onPageComplete?: PipelineOptions["onPageComplete"];
  onPageFailed?: PipelineOptions["onPageFailed"];
  page: MangaPage;
  pageIndex: number;
  runPaths: ChapterRunPaths;
  runtime: TranslationRuntimePort;
  server: ModelEndpointHandle;
  signal: AbortSignal;
  skipOcrPrepass: boolean;
  warningCollector: WarningCollector;
}): Promise<void> {
  let successPage: MangaPage | null = null;
  let lastErrorMessage = "";
  let lastError: unknown;
  let lastPageOptions: TranslationOptions | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const pageOptions = buildRequestPageOptions({
      attempt,
      baseOptions,
      context,
      maxAttempts,
      ocrHintsByPageId,
      page,
      pageIndex,
      signal,
      skipOcrPrepass,
    });
    lastPageOptions = pageOptions;
    emitPageRunning(context, page, pageIndex, attempt, maxAttempts);

    try {
      successPage = await translatePageAttempt({
        context,
        jobId: context.jobId,
        onPageComplete,
        page,
        pageIndex,
        pageOptions,
        runtime,
        server,
        warningCollector,
      });
      break;
    } catch (error) {
      if (isAbortErrorLike(error) || isNonRetriableRuntimeError(error)) {
        throw error;
      }
      lastError = error;
      lastErrorMessage = error instanceof Error ? error.message : String(error);
      warningCollector.addAttemptFailure({
        pageName: page.name,
        attempt,
        maxAttempts,
        message: lastErrorMessage,
      });
      logAttemptFailure({
        attempt,
        error,
        lastPageOptions: pageOptions,
        maxAttempts,
        page,
        pageIndex,
        runPaths,
        context,
      });

      if (attempt < maxAttempts) {
        emitPageRetry(context, page, pageIndex, attempt, maxAttempts);
      }
    }
  }

  if (successPage) {
    completedPagesById.set(page.id, successPage);
    return;
  }

  warningCollector.addPageSkipped({
    pageName: page.name,
    maxAttempts,
    message: lastErrorMessage,
  });
  logSkippedPage({
    context,
    lastError,
    lastErrorMessage,
    lastPageOptions,
    maxAttempts,
    page,
    pageIndex,
    runPaths,
  });
  const failedPage = buildFailedPage(page, lastErrorMessage);
  completedPagesById.set(page.id, failedPage);
  await onPageFailed?.(failedPage, lastErrorMessage);
  emitPageSkipped(context, page, pageIndex, maxAttempts);
}

async function translatePageAttempt({
  context,
  jobId,
  onPageComplete,
  page,
  pageIndex,
  pageOptions,
  runtime,
  server,
  warningCollector,
}: {
  context: ProgressContext;
  jobId: string;
  onPageComplete?: PipelineOptions["onPageComplete"];
  page: MangaPage;
  pageIndex: number;
  pageOptions: TranslationOptions;
  runtime: TranslationRuntimePort;
  server: ModelEndpointHandle;
  warningCollector: WarningCollector;
}): Promise<MangaPage> {
  const result = await requestPageTranslation({ pageOptions, runtime, server });
  const pageResult = await buildPageResult({
    jobId,
    page,
    pageOptions,
    result,
    runtime,
  });

  if (pageResult.kind === "no-text") {
    await onPageComplete?.(pageResult.page);
    emitNoTextPage(context, page, pageIndex);
    return pageResult.page;
  }

  warningCollector.add(...pageResult.warnings);
  await onPageComplete?.(pageResult.page);
  emitPageDone(context, page, pageIndex, pageResult.detail);
  return pageResult.page;
}

function logAttemptFailure({
  attempt,
  context,
  error,
  lastPageOptions,
  maxAttempts,
  page,
  pageIndex,
  runPaths,
}: {
  attempt: number;
  context: ProgressContext;
  error: unknown;
  lastPageOptions: TranslationOptions;
  maxAttempts: number;
  page: MangaPage;
  pageIndex: number;
  runPaths: ChapterRunPaths;
}): void {
  logWarn("Analysis attempt failed", {
    failureCategory: classifyFailure(error),
    jobId: context.jobId,
    page: summarizePage(page),
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    attempt,
    attemptTotal: maxAttempts,
    willRetry: attempt < maxAttempts,
    runPaths,
    pageOptions: summarizeTranslationOptions(lastPageOptions),
    error,
  });
}

function logSkippedPage({
  context,
  lastError,
  lastErrorMessage,
  lastPageOptions,
  maxAttempts,
  page,
  pageIndex,
  runPaths,
}: {
  context: ProgressContext;
  lastError: unknown;
  lastErrorMessage: string;
  lastPageOptions: TranslationOptions | null;
  maxAttempts: number;
  page: MangaPage;
  pageIndex: number;
  runPaths: ChapterRunPaths;
}): void {
  logError("Analysis page skipped after retries", {
    failureCategory: classifyFailure(lastError),
    jobId: context.jobId,
    page: summarizePage(page),
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    attemptTotal: maxAttempts,
    runPaths,
    lastPageOptions: lastPageOptions
      ? summarizeTranslationOptions(lastPageOptions)
      : null,
    lastErrorMessage,
    error: lastError,
  });
}
