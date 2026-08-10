/* eslint-disable max-lines -- analysis checkpoints and terminal recovery stay co-located for cancellation auditability */
import type {
  StartAnalysisRequest,
  StartAnalysisResult,
} from "../../shared/analysisTypes";
import type { JobEvent } from "../../shared/jobTypes";
import {
  finalizeRunningPages,
  getRunPaths,
  markChapterPagesRunning,
  openChapter,
  resolvePagesForRun,
  resolveWorkContextForChapter,
  updatePageAfterAnalysis,
  updatePagesAfterAnalysis,
} from "../library";
import { logError } from "../logger";
import { tMain } from "./localization";
import type { PipelineOptions } from "../pipeline/types";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  createPageJobTargetSnapshot,
  createPageRevision,
  type PageJobTargetSnapshot,
  type PageRevision,
} from "../../shared/pageRevision";
import { runWholePagePipeline } from "../wholePagePipeline";
import { throwIfAborted } from "../pipeline/failure";
import { isAbortError } from "./jobEvents";
import type { JobResourceCleanup } from "./jobLifetimeCleanup";
import type { TranslationJobContext } from "./translationJobTypes";
import { resolvePreviousChapterStoryPages } from "../previousChapterContext";

type EmitJobEvent = (event: JobEvent) => void;
type ResolvedRunPages = Awaited<ReturnType<typeof resolvePagesForRun>>;
type ChapterRunPaths = Awaited<ReturnType<typeof getRunPaths>>;
type PipelineResult = Awaited<ReturnType<typeof runWholePagePipeline>>;

export type AnalysisJobState = {
  resolved: ResolvedRunPages | null;
  pageIds: string[];
  runPaths: ChapterRunPaths | null;
  targetSnapshots?: PageJobTargetSnapshot[];
};

export type AnalysisJobRunnerDependencies = {
  resolveWorkContextForChapter: typeof resolveWorkContextForChapter;
  resolvePreviousChapterStoryPages: typeof resolvePreviousChapterStoryPages;
  markChapterPagesRunning: typeof markChapterPagesRunning;
  getRunPaths: typeof getRunPaths;
  runWholePagePipeline: typeof runWholePagePipeline;
};

const productionAnalysisJobRunnerDependencies: AnalysisJobRunnerDependencies = {
  resolveWorkContextForChapter,
  resolvePreviousChapterStoryPages,
  markChapterPagesRunning,
  getRunPaths,
  runWholePagePipeline,
};

export async function runResolvedAnalysisJob(
  {
    context,
    request,
    id,
    abortController,
    emit,
    resolved,
    state,
    registerResourceCleanup,
  }: {
    context: TranslationJobContext;
    request: StartAnalysisRequest;
    id: string;
    abortController: AbortController;
    emit: EmitJobEvent;
    resolved: ResolvedRunPages;
    state: AnalysisJobState;
    registerResourceCleanup: (cleanup: JobResourceCleanup) => void;
  },
  dependencies: AnalysisJobRunnerDependencies = productionAnalysisJobRunnerDependencies,
): Promise<StartAnalysisResult> {
  throwIfAborted(abortController.signal);
  state.pageIds = resolved.pages.map((page) => page.id);
  state.targetSnapshots = resolved.pages.map((page) =>
    createPageJobTargetSnapshot(request.chapterId, page),
  );
  const workContext = await dependencies.resolveWorkContextForChapter(
    request.chapterId,
  );
  throwIfAborted(abortController.signal);
  const previousStoryPages = request.collectPageContext
    ? await dependencies.resolvePreviousChapterStoryPages(resolved.chapter)
    : [];
  throwIfAborted(abortController.signal);
  const expectedRevisionByPageId = await prepareRunningAnalysisPages(
    request.chapterId,
    resolved.pages,
    dependencies.markChapterPagesRunning,
  );
  throwIfAborted(abortController.signal);
  state.runPaths = await dependencies.getRunPaths(request.chapterId, id);
  throwIfAborted(abortController.signal);
  const result = await dependencies.runWholePagePipeline({
    jobId: id,
    emit,
    ...buildAnalysisPipelineCallbacks({
      expectedRevisionByPageId,
      request,
      registerResourceCleanup,
    }),
    pages: resolved.pages,
    runPaths: state.runPaths,
    signal: abortController.signal,
    blockMode: request.blockMode,
    decodeImage: context.decodeImage,
    workContext: {
      ...workContext,
      chapterId: request.chapterId,
      recentPageCount: 6,
      previousStoryPages,
    },
    collectPageContext: request.collectPageContext,
    naturalTextLayout: request.naturalTextLayout,
    autoFontMatching: request.autoFontMatching,
    canonicalPageIndexById: new Map(
      resolved.chapter.pages.map((page, index) => [page.id, index]),
    ),
  });

  throwIfAborted(abortController.signal);
  return completeAnalysisJob(
    id,
    emit,
    request,
    resolved,
    result,
    openChapter,
    abortController.signal,
  );
}

export async function handleAnalysisJobError({
  abortController,
  emit,
  error,
  id,
  request,
  state,
  context,
}: {
  abortController: AbortController;
  emit: EmitJobEvent;
  error: unknown;
  id: string;
  request: StartAnalysisRequest;
  state: AnalysisJobState;
  context: TranslationJobContext;
}): Promise<StartAnalysisResult> {
  const lastEvent = getLastJobEvent(context, id);
  if (isAbortError(error) || abortController.signal.aborted) {
    return handleAnalysisAbort(id, emit, request, state, lastEvent);
  }
  return handleAnalysisFailure(id, emit, request, state, lastEvent, error);
}

async function prepareRunningAnalysisPages(
  chapterId: string,
  pages: MangaPage[],
  markPagesRunning: typeof markChapterPagesRunning,
): Promise<Map<string, PageRevision>> {
  const revisions = new Map(
    pages.map((page) => [page.id, createPageRevision(page)]),
  );
  await markPagesRunning(
    chapterId,
    pages.map((page) => page.id),
  );
  return revisions;
}

function buildAnalysisPipelineCallbacks({
  expectedRevisionByPageId,
  request,
  registerResourceCleanup,
}: {
  expectedRevisionByPageId: Map<string, PageRevision>;
  request: StartAnalysisRequest;
  registerResourceCleanup: (cleanup: JobResourceCleanup) => void;
}): Pick<
  PipelineOptions,
  "onCleanupReady" | "onPageComplete" | "onPagesComplete" | "onPageFailed"
> {
  return {
    onCleanupReady: registerResourceCleanup,
    onPageComplete: async (page) => {
      return updatePageAfterAnalysis(
        request.chapterId,
        withTranslationCompletionReceipt(page, request),
        [],
        "completed",
        undefined,
        expectedRevisionByPageId.get(page.id),
      );
    },
    onPagesComplete: async (pages) => {
      return updatePagesAfterAnalysis(
        request.chapterId,
        pages.map((page) => ({
          page: withTranslationCompletionReceipt(page, request),
          warnings: [],
          status: "completed" as const,
          expectedRevision: expectedRevisionByPageId.get(page.id),
        })),
      );
    },
    onPageFailed: async (page, errorMessage) => {
      await updatePageAfterAnalysis(
        request.chapterId,
        page,
        [errorMessage],
        "failed",
        undefined,
        expectedRevisionByPageId.get(page.id),
      );
    },
  };
}

function withTranslationCompletionReceipt(
  page: MangaPage,
  request: StartAnalysisRequest,
): MangaPage {
  return {
    ...page,
    translationCompletion: request.completionWorkflow
      ? { workflow: request.completionWorkflow, status: "pending" }
      : undefined,
  };
}

export async function completeAnalysisJob(
  id: string,
  emit: EmitJobEvent,
  request: StartAnalysisRequest,
  resolved: ResolvedRunPages,
  result: PipelineResult,
  openPersistedChapter: typeof openChapter = openChapter,
  signal?: AbortSignal,
): Promise<StartAnalysisResult> {
  // The pipeline result can still look completed when persisting a page loses
  // an optimistic-concurrency race. Re-open the chapter before emitting a
  // terminal event and treat anything other than a persisted completed target
  // as an incomplete job.
  const chapter = await openPersistedChapter(request.chapterId);
  if (signal) {
    throwIfAborted(signal);
  }
  const persistedPagesById = new Map(
    chapter.pages.map((page) => [page.id, page]),
  );
  const incompletePageCount = resolved.pages.filter(
    (page) =>
      !isPersistedAnalysisTargetComplete(
        persistedPagesById.get(page.id),
        request,
      ),
  ).length;

  if (incompletePageCount > 0) {
    const message = tMain("translation.incompleteWithFailures", {
      count: incompletePageCount,
    });
    emit({
      id,
      kind: "gemma-analysis",
      status: "failed",
      progressText: message,
      phase: "failed",
      progressCurrent: resolved.pages.length,
      progressTotal: resolved.pages.length,
      pageTotal: resolved.pages.length,
      detail: message,
    });
    return {
      status: "failed",
      chapter,
      warnings: result.warnings,
      error: message,
    };
  }

  emit({
    id,
    kind: "gemma-analysis",
    status: "completed",
    progressText: tMain("translation.completed"),
    phase: "done",
    progressCurrent: resolved.pages.length,
    progressTotal: resolved.pages.length,
    pageTotal: resolved.pages.length,
  });

  return {
    status: "completed",
    chapter,
    warnings: result.warnings,
  };
}

function isPersistedAnalysisTargetComplete(
  page: MangaPage | undefined,
  request: StartAnalysisRequest,
): boolean {
  if (page?.analysisStatus !== "completed") return false;
  if (!request.completionWorkflow) return true;
  return (
    page.translationCompletion?.workflow === request.completionWorkflow &&
    page.translationCompletion.status === "pending"
  );
}

async function handleAnalysisAbort(
  id: string,
  emit: EmitJobEvent,
  request: StartAnalysisRequest,
  state: AnalysisJobState,
  lastEvent: JobEvent | undefined,
): Promise<StartAnalysisResult> {
  if (state.pageIds.length > 0) {
    await finalizeRunningPagesSafely(
      request.chapterId,
      state.pageIds,
      "idle",
      undefined,
      id,
    );
  }
  const chapter = await openChapter(request.chapterId).catch(
    () => state.resolved?.chapter,
  );
  emit({
    id,
    kind: "gemma-analysis",
    status: "cancelled",
    progressText: tMain("jobs.cancelled"),
    phase: "cancelled",
    progressCurrent: lastEvent?.progressCurrent,
    progressTotal: lastEvent?.progressTotal,
    pageIndex: lastEvent?.pageIndex,
    pageTotal: lastEvent?.pageTotal,
    attempt: lastEvent?.attempt,
    attemptTotal: lastEvent?.attemptTotal,
  });
  return {
    status: "cancelled",
    chapter,
  };
}

async function handleAnalysisFailure(
  id: string,
  emit: EmitJobEvent,
  request: StartAnalysisRequest,
  state: AnalysisJobState,
  lastEvent: JobEvent | undefined,
  error: unknown,
): Promise<StartAnalysisResult> {
  const message = error instanceof Error ? error.message : String(error);
  if (state.pageIds.length > 0) {
    await finalizeRunningPagesSafely(
      request.chapterId,
      state.pageIds,
      "failed",
      message,
      id,
    );
  }
  logError("Analysis job failed", {
    jobId: id,
    request,
    chapterId: request.chapterId,
    runMode: request.runMode,
    pageIds: state.pageIds,
    resolvedPageCount: state.resolved?.pages.length,
    resolvedPageNames: state.resolved?.pages.map((page) => page.name),
    runPaths: state.runPaths,
    lastEvent,
    error,
  });
  const chapter = await openChapter(request.chapterId).catch(
    () => state.resolved?.chapter,
  );
  emitFailedAnalysisJob(id, emit, lastEvent, message);
  return {
    status: "failed",
    error: message,
    chapter,
  };
}

function emitFailedAnalysisJob(
  id: string,
  emit: EmitJobEvent,
  lastEvent: JobEvent | undefined,
  message: string,
): void {
  emit({
    id,
    kind: "gemma-analysis",
    status: "failed",
    progressText: tMain("jobs.failed"),
    phase: "failed",
    progressCurrent: lastEvent?.progressCurrent,
    progressTotal: lastEvent?.progressTotal,
    pageIndex: lastEvent?.pageIndex,
    pageTotal: lastEvent?.pageTotal,
    attempt: lastEvent?.attempt,
    attemptTotal: lastEvent?.attemptTotal,
    detail: message,
  });
}

async function finalizeRunningPagesSafely(
  chapterId: string,
  pageIds: string[],
  status: "idle" | "failed",
  errorMessage: string | undefined,
  jobId: string,
): Promise<void> {
  try {
    await finalizeRunningPages(chapterId, pageIds, status, errorMessage);
  } catch (error) {
    logError("Failed to finalize running pages after analysis job error", {
      jobId,
      chapterId,
      pageCount: pageIds.length,
      status,
      error,
    });
  }
}

function getLastJobEvent(
  context: TranslationJobContext,
  id: string,
): JobEvent | undefined {
  return context.jobs.current?.id === id
    ? context.jobs.current.lastEvent
    : undefined;
}
