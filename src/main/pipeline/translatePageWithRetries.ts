import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  classifyFailure,
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
  PipelineOptions,
  PipelineRegionContext,
  PipelineWorkContext,
} from "./types";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import type { WarningCollector } from "./warningCollector";
import type { ChapterRunPaths } from "../library";
import { logAttemptFailure, logSkippedPage } from "./translationAttemptLogging";
import type { PipelineDiagnostics } from "./translationAttemptLogging";
import { preparePageTranslationAttempt } from "./pageTranslationAttempt";
import type { PreparedPageBuildResult } from "./pageResultBuilder";
import type { PageProcessingTimingCollector } from "./pageProcessingTiming";

type TranslatePageWithRetriesOptions = {
  baseOptions: TranslationOptions;
  completedPagesById: Map<string, MangaPage>;
  context: ProgressContext;
  maxAttempts: number;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
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
  cumulativeContextDetail?: PipelineOptions["cumulativeContextDetail"];
  diagnostics: PipelineDiagnostics;
  timing: PageProcessingTimingCollector;
};

type PageTranslationAttemptResult = {
  lastError?: unknown;
  lastErrorMessage: string;
  lastPageOptions: TranslationOptions | null;
  successPrepared: PreparedPageBuildResult | null;
};

type PageTranslationAttemptState = Pick<
  PageTranslationAttemptResult,
  "lastError" | "lastErrorMessage" | "lastPageOptions"
> & {
  lastFailureCategory?: string;
};

export async function preparePageWithRetries({
  baseOptions,
  completedPagesById,
  context,
  maxAttempts,
  ocrHintsByPageId,
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
  cumulativeContextDetail,
  diagnostics,
  timing,
}: TranslatePageWithRetriesOptions): Promise<PreparedPageBuildResult | null> {
  const result = await runPageTranslationAttempts({
    baseOptions,
    context,
    maxAttempts,
    ocrHintsByPageId,
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
    cumulativeContextDetail,
    diagnostics,
    timing,
  });
  if (result.successPrepared) return result.successPrepared;
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
  return null;
}

async function runPageTranslationAttempts({
  baseOptions,
  context,
  maxAttempts,
  ocrHintsByPageId,
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
  cumulativeContextDetail,
  diagnostics,
  timing,
}: Omit<
  TranslatePageWithRetriesOptions,
  "completedPagesById" | "onPageFailed"
>): Promise<PageTranslationAttemptResult> {
  let successPrepared: PreparedPageBuildResult | null = null;
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
      cumulativeContextDetail,
    });
    // empty-overlay-items로 실패한 페이지는 모델이 bbox를 아예 만들지 못한
    // 것이다. 재시도가 동일 요청을 반복하면 결과도 동일하므로(021.jpg 5회 동일
    // 실패), 2회차+는 요청 단위로 대비 강화 변형을 추가해 모델이 텍스트를
    // 검출할 기회를 늘린다. includeEnhancedVariant/enhancedContrast는 서버
    // 재시작 없이 요청마다 바꿀 수 있는 유일한 르버다.
    applyEnhancedRetryVariant(pageOptions, attempt, state.lastFailureCategory);
    state.lastPageOptions = pageOptions;
    emitPageRunning(context, page, progressPageIndex, attempt, maxAttempts);

    const success = await tryPageTranslationAttempt({
      attempt,
      context,
      maxAttempts,
      page,
      pageIndex: progressPageIndex,
      pageOptions,
      runPaths,
      runtime,
      server,
      state,
      warningCollector,
      diagnostics,
      timing,
    });
    if (success) {
      successPrepared = success;
      break;
    }
  }

  return {
    ...state,
    successPrepared,
  };
}

function applyEnhancedRetryVariant(
  pageOptions: TranslationOptions,
  attempt: number,
  lastFailureCategory: string | undefined,
): void {
  if (attempt <= 1 || lastFailureCategory !== "empty-overlay-items") return;
  pageOptions.includeEnhancedVariant = true;
  pageOptions.enhancedContrast = Math.max(
    pageOptions.enhancedContrast ?? 1.35,
    1.6,
  );
}

async function tryPageTranslationAttempt({
  attempt,
  context,
  maxAttempts,
  page,
  pageIndex,
  pageOptions,
  runPaths,
  runtime,
  server,
  state,
  warningCollector,
  diagnostics,
  timing,
}: {
  attempt: number;
  context: ProgressContext;
  maxAttempts: number;
  page: MangaPage;
  pageIndex: number;
  pageOptions: TranslationOptions;
  runPaths: ChapterRunPaths;
  runtime: TranslationRuntimePort;
  server: ModelEndpointHandle;
  state: PageTranslationAttemptState;
  warningCollector: WarningCollector;
  diagnostics: PipelineDiagnostics;
  timing: PageProcessingTimingCollector;
}): Promise<PreparedPageBuildResult | null> {
  try {
    return await preparePageTranslationAttempt({
      jobId: context.jobId,
      page,
      pageOptions,
      runtime,
      server,
      timing,
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
  state.lastFailureCategory = classifyFailure(error);
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
  warningCollector.recordTerminalFailure(result.lastError);
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
