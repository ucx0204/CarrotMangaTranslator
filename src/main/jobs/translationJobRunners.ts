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
import { runWholePagePipeline } from "../wholePagePipeline";
import { isAbortError } from "./jobEvents";
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
};

export async function runResolvedAnalysisJob({
  context,
  request,
  id,
  abortController,
  emit,
  resolved,
  state,
}: {
  context: TranslationJobContext;
  request: StartAnalysisRequest;
  id: string;
  abortController: AbortController;
  emit: EmitJobEvent;
  resolved: ResolvedRunPages;
  state: AnalysisJobState;
}): Promise<StartAnalysisResult> {
  state.pageIds = resolved.pages.map((page) => page.id);
  const workContext = await resolveWorkContextForChapter(request.chapterId);
  const previousStoryPages = request.collectPageContext
    ? await resolvePreviousChapterStoryPages(resolved.chapter)
    : [];
  const expectedUpdatedAtByPageId = await prepareRunningAnalysisPages(
    request.chapterId,
    state.pageIds,
  );
  state.runPaths = await getRunPaths(request.chapterId, id);
  const result = await runWholePagePipeline({
    jobId: id,
    emit,
    ...buildAnalysisPipelineCallbacks({
      context,
      expectedUpdatedAtByPageId,
      id,
      request,
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
    canonicalPageIndexById: new Map(
      resolved.chapter.pages.map((page, index) => [page.id, index]),
    ),
  });

  if (abortController.signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  return completeAnalysisJob(id, emit, request, resolved, result);
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
  pageIds: string[],
): Promise<Map<string, string>> {
  const runningChapter = await markChapterPagesRunning(chapterId, pageIds);
  return new Map(
    runningChapter.pages
      .filter((page) => pageIds.includes(page.id))
      .map((page) => [page.id, page.updatedAt]),
  );
}

function buildAnalysisPipelineCallbacks({
  context,
  expectedUpdatedAtByPageId,
  id,
  request,
}: {
  context: TranslationJobContext;
  expectedUpdatedAtByPageId: Map<string, string>;
  id: string;
  request: StartAnalysisRequest;
}): Pick<
  PipelineOptions,
  "onCleanupReady" | "onPageComplete" | "onPagesComplete" | "onPageFailed"
> {
  return {
    onCleanupReady: (cleanup) => {
      context.jobs.setCleanup(id, cleanup);
    },
    onPageComplete: async (page) => {
      return updatePageAfterAnalysis(
        request.chapterId,
        page,
        [],
        "completed",
        expectedUpdatedAtByPageId.get(page.id),
      );
    },
    onPagesComplete: async (pages) => {
      return updatePagesAfterAnalysis(
        request.chapterId,
        pages.map((page) => ({
          page,
          warnings: [],
          status: "completed" as const,
          expectedUpdatedAt: expectedUpdatedAtByPageId.get(page.id),
        })),
      );
    },
    onPageFailed: async (page, errorMessage) => {
      await updatePageAfterAnalysis(
        request.chapterId,
        page,
        [errorMessage],
        "failed",
        expectedUpdatedAtByPageId.get(page.id),
      );
    },
  };
}

function completeAnalysisJob(
  id: string,
  emit: EmitJobEvent,
  request: StartAnalysisRequest,
  resolved: ResolvedRunPages,
  result: PipelineResult,
): Promise<StartAnalysisResult> {
  const failedPageCount = result.pages.filter(
    (page) => page.analysisStatus === "failed",
  ).length;
  if (failedPageCount === result.pages.length) {
    throw new Error(tMain("translation.allPagesFailed"));
  }

  emit({
    id,
    kind: "gemma-analysis",
    status: "completed",
    progressText:
      failedPageCount > 0
        ? tMain("translation.completedWithFailures", {
            count: failedPageCount,
          })
        : tMain("translation.completed"),
    phase: "done",
    progressCurrent: resolved.pages.length,
    progressTotal: resolved.pages.length,
    pageTotal: resolved.pages.length,
  });

  return openChapter(request.chapterId).then((chapter) => ({
    status: "completed",
    chapter,
    warnings: result.warnings,
  }));
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
    chapter: await openChapter(request.chapterId).catch(
      () => state.resolved?.chapter,
    ),
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
  emitFailedAnalysisJob(id, emit, lastEvent, message);
  return {
    status: "failed",
    error: message,
    chapter: await openChapter(request.chapterId).catch(
      () => state.resolved?.chapter,
    ),
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
