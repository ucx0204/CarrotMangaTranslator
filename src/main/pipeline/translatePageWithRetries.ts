import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  isAbortErrorLike,
  isNonRetriableRuntimeError,
  throwIfAborted,
} from "./failure";
import { buildFailedPage, buildRequestPageOptions } from "./pageResultBuilder";
import {
  emitPageRetry,
  emitPageRunning,
  emitPageSkipped,
  type ProgressContext,
} from "./progressEvents";
import type {
  ModelEndpointHandle,
  OcrBboxResult,
  PageContextPayload,
  PipelineOptions,
  PipelineRegionContext,
  PipelineWorkContext,
} from "./types";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import type { WarningCollector } from "./warningCollector";
import type { ChapterRunPaths } from "../library";
import { logAttemptFailure, logSkippedPage } from "./translationAttemptLogging";
import type { PipelineDiagnostics } from "./translationAttemptLogging";
import { translatePageAttempt } from "./pageTranslationAttempt";
import type { FontMatchingPageInferencePort } from "./fontMatchingPagePixelInferenceTypes";
import type { AutomaticFontPageCoordinatorV2 } from "./automaticFontMatchingV2PageCoordinator";

type TranslatePageWithRetriesOptions = {
  baseOptions: TranslationOptions;
  completedPagesById: Map<string, MangaPage>;
  context: ProgressContext;
  maxAttempts: number;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  onPageComplete?: PipelineOptions["onPageComplete"];
  onPageFailed?: PipelineOptions["onPageFailed"];
  page: MangaPage;
  pageIndex: number;
  progressPageIndex?: number;
  runPaths: ChapterRunPaths;
  runtime: TranslationRuntimePort;
  server: ModelEndpointHandle;
  signal: AbortSignal;
  skipOcrPrepass: boolean;
  blockMode?: PipelineOptions["blockMode"];
  warningCollector: WarningCollector;
  workContext?: PipelineWorkContext;
  regionContext?: PipelineRegionContext;
  collectPageContext?: boolean;
  diagnostics: PipelineDiagnostics;
  fontMatchingPageInference?: FontMatchingPageInferencePort;
  fontMatchingChapterCoordinator?: AutomaticFontPageCoordinatorV2;
};

type PageTranslationAttemptResult = {
  lastError?: unknown;
  lastErrorMessage: string;
  lastPageOptions: TranslationOptions | null;
  successPage: MangaPage | null;
  successPageContext?: PageContextPayload;
  successApproved: boolean;
};

type PageTranslationAttemptState = Pick<
  PageTranslationAttemptResult,
  "lastError" | "lastErrorMessage" | "lastPageOptions"
>;

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
  progressPageIndex = pageIndex,
  runPaths,
  runtime,
  server,
  signal,
  skipOcrPrepass,
  blockMode,
  warningCollector,
  workContext,
  regionContext,
  collectPageContext,
  diagnostics,
  fontMatchingPageInference,
  fontMatchingChapterCoordinator,
}: TranslatePageWithRetriesOptions): Promise<{
  pageContext?: PageContextPayload;
  approved: boolean;
}> {
  const result = await runPageTranslationAttempts({
    baseOptions,
    context,
    maxAttempts,
    ocrHintsByPageId,
    onPageComplete,
    page,
    pageIndex,
    progressPageIndex,
    runPaths,
    runtime,
    server,
    signal,
    skipOcrPrepass,
    blockMode,
    warningCollector,
    workContext,
    regionContext,
    collectPageContext,
    diagnostics,
    fontMatchingPageInference,
    fontMatchingChapterCoordinator,
  });
  if (result.successPage) {
    completedPagesById.set(page.id, result.successPage);
    return {
      pageContext: result.successPageContext,
      approved: result.successApproved,
    };
  }
  await saveFailedPageAfterRetries({
    completedPagesById,
    context,
    maxAttempts,
    onPageFailed,
    page,
    pageIndex,
    progressPageIndex,
    result,
    runPaths,
    warningCollector,
    diagnostics,
  });
  return { approved: false };
}

// eslint-disable-next-line max-lines-per-function -- retry state must remain within one attempt loop
async function runPageTranslationAttempts({
  baseOptions,
  context,
  maxAttempts,
  ocrHintsByPageId,
  onPageComplete,
  page,
  pageIndex,
  progressPageIndex = pageIndex,
  runPaths,
  runtime,
  server,
  signal,
  skipOcrPrepass,
  blockMode,
  warningCollector,
  workContext,
  regionContext,
  collectPageContext,
  diagnostics,
  fontMatchingPageInference,
  fontMatchingChapterCoordinator,
}: Omit<
  TranslatePageWithRetriesOptions,
  "completedPagesById" | "onPageFailed"
>): Promise<PageTranslationAttemptResult> {
  let successPage: MangaPage | null = null;
  let successPageContext: PageContextPayload | undefined;
  let successApproved = false;
  const state: PageTranslationAttemptState = {
    lastErrorMessage: "",
    lastPageOptions: null,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const pageOptions = buildRequestPageOptions({
      attempt,
      baseOptions,
      blockMode,
      context,
      maxAttempts,
      ocrHintsByPageId,
      page,
      pageIndex,
      progressPageIndex,
      signal,
      skipOcrPrepass,
      workContext,
      regionContext,
      collectPageContext,
    });
    state.lastPageOptions = pageOptions;
    emitPageRunning(context, page, progressPageIndex, attempt, maxAttempts);

    const success = await tryPageTranslationAttempt({
      attempt,
      context,
      maxAttempts,
      onPageComplete,
      page,
      pageIndex: progressPageIndex,
      pageOptions,
      runPaths,
      runtime,
      server,
      state,
      warningCollector,
      diagnostics,
      fontMatchingPageInference,
      fontMatchingChapterCoordinator,
    });
    if (success) {
      successPage = success.page;
      successPageContext = success.pageContext;
      successApproved = success.approved;
      break;
    }
  }

  return {
    ...state,
    successPage,
    successPageContext,
    successApproved,
  };
}

async function tryPageTranslationAttempt({
  attempt,
  context,
  maxAttempts,
  onPageComplete,
  page,
  pageIndex,
  pageOptions,
  runPaths,
  runtime,
  server,
  state,
  warningCollector,
  diagnostics,
  fontMatchingPageInference,
  fontMatchingChapterCoordinator,
}: {
  attempt: number;
  context: ProgressContext;
  maxAttempts: number;
  onPageComplete?: PipelineOptions["onPageComplete"];
  page: MangaPage;
  pageIndex: number;
  pageOptions: TranslationOptions;
  runPaths: ChapterRunPaths;
  runtime: TranslationRuntimePort;
  server: ModelEndpointHandle;
  state: PageTranslationAttemptState;
  warningCollector: WarningCollector;
  diagnostics: PipelineDiagnostics;
  fontMatchingPageInference?: FontMatchingPageInferencePort;
  fontMatchingChapterCoordinator?: AutomaticFontPageCoordinatorV2;
}): Promise<{
  page: MangaPage;
  pageContext?: PageContextPayload;
  approved: boolean;
} | null> {
  try {
    return await translatePageAttempt({
      context,
      jobId: context.jobId,
      onPageComplete,
      page,
      pageIndex,
      pageOptions,
      runtime,
      server,
      warningCollector,
      fontMatchingPageInference,
      fontMatchingChapterCoordinator,
    });
  } catch (error) {
    if (isAbortErrorLike(error) || isNonRetriableRuntimeError(error)) {
      throw error;
    }
    handlePageAttemptFailure({
      attempt,
      context,
      error,
      maxAttempts,
      page,
      pageIndex,
      pageOptions,
      runPaths,
      state,
      warningCollector,
      diagnostics,
    });
    return null;
  }
}

function handlePageAttemptFailure({
  attempt,
  context,
  error,
  maxAttempts,
  page,
  pageIndex,
  pageOptions,
  runPaths,
  state,
  warningCollector,
  diagnostics,
}: {
  attempt: number;
  context: ProgressContext;
  error: unknown;
  maxAttempts: number;
  page: MangaPage;
  pageIndex: number;
  pageOptions: TranslationOptions;
  runPaths: ChapterRunPaths;
  state: PageTranslationAttemptState;
  warningCollector: WarningCollector;
  diagnostics: PipelineDiagnostics;
}): void {
  state.lastError = error;
  state.lastErrorMessage =
    error instanceof Error ? error.message : String(error);
  warningCollector.addAttemptFailure({
    pageName: page.name,
    attempt,
    maxAttempts,
    message: state.lastErrorMessage,
  });
  logAttemptFailure(
    {
      attempt,
      context,
      error,
      lastPageOptions: pageOptions,
      maxAttempts,
      page,
      pageIndex,
      runPaths,
    },
    diagnostics,
  );
  if (attempt < maxAttempts) {
    emitPageRetry(context, page, pageIndex, attempt, maxAttempts);
  }
}

async function saveFailedPageAfterRetries({
  completedPagesById,
  context,
  maxAttempts,
  onPageFailed,
  page,
  pageIndex,
  progressPageIndex = pageIndex,
  result,
  runPaths,
  warningCollector,
  diagnostics,
}: {
  completedPagesById: Map<string, MangaPage>;
  context: ProgressContext;
  maxAttempts: number;
  onPageFailed?: PipelineOptions["onPageFailed"];
  page: MangaPage;
  pageIndex: number;
  progressPageIndex?: number;
  result: PageTranslationAttemptResult;
  runPaths: ChapterRunPaths;
  warningCollector: WarningCollector;
  diagnostics: PipelineDiagnostics;
}): Promise<void> {
  warningCollector.addPageSkipped({
    pageName: page.name,
    maxAttempts,
    message: result.lastErrorMessage,
  });
  logSkippedPage(
    {
      context,
      lastError: result.lastError,
      lastErrorMessage: result.lastErrorMessage,
      lastPageOptions: result.lastPageOptions,
      maxAttempts,
      page,
      pageIndex: progressPageIndex,
      runPaths,
    },
    diagnostics,
  );
  const failedPage = buildFailedPage(page, result.lastErrorMessage);
  completedPagesById.set(page.id, failedPage);
  await onPageFailed?.(failedPage, result.lastErrorMessage);
  emitPageSkipped(context, page, progressPageIndex, maxAttempts);
}
