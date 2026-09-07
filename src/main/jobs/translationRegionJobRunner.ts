import { waitForRegionTextReview } from "./regionTranslationReview";
import { completeRegionTranslation } from "./translationRegionCompletion";
import { createPageRevision } from "../../shared/pageRevision";
import type {
  RegionAnalysisRequest,
  RegionAnalysisResult,
} from "../../shared/analysisTypes";
import type { JobEvent, JobFailureGuidance } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  createRegionCropPage,
  mapRegionBlocksToPageBlocks,
} from "../regionCrop";
import {
  appendAnalyzedPageBlocks,
  getRunPaths,
  openChapter,
  resolveWorkContextForChapter,
} from "../library";
import { logError } from "../logger";
import { tMain } from "./localization";
import { runWholePagePipeline } from "../wholePagePipeline";
import { readJobFailureGuidance, throwIfAborted } from "../pipeline/failure";
import { isAbortError } from "./jobEvents";
import type { JobResourceCleanup } from "./jobLifetimeCleanup";
import type { TranslationJobContext } from "./translationJobTypes";

type EmitJobEvent = (event: JobEvent) => void;
type ChapterRunPaths = Awaited<ReturnType<typeof getRunPaths>>;
type OpenedChapter = Awaited<ReturnType<typeof openChapter>>;
type PipelineResult = Awaited<ReturnType<typeof runWholePagePipeline>>;

export type RegionJobState = {
  chapter: OpenedChapter | null;
  runPaths: ChapterRunPaths | null;
};

export type RegionJobRunnerDependencies = {
  openChapter: typeof openChapter;
  getRunPaths: typeof getRunPaths;
  createRegionCropPage: typeof createRegionCropPage;
  resolveWorkContextForChapter: typeof resolveWorkContextForChapter;
  runWholePagePipeline: typeof runWholePagePipeline;
  appendAnalyzedPageBlocks: typeof appendAnalyzedPageBlocks;
};

const productionRegionJobRunnerDependencies: RegionJobRunnerDependencies = {
  openChapter,
  getRunPaths,
  createRegionCropPage,
  resolveWorkContextForChapter,
  runWholePagePipeline,
  appendAnalyzedPageBlocks,
};

export async function runRegionTranslationJob(
  {
    context,
    request,
    id,
    abortController,
    emit,
    state,
    registerResourceCleanup,
  }: {
    context: TranslationJobContext;
    request: RegionAnalysisRequest;
    id: string;
    abortController: AbortController;
    emit: EmitJobEvent;
    state: RegionJobState;
    registerResourceCleanup: (cleanup: JobResourceCleanup) => void;
  },
  dependencies: RegionJobRunnerDependencies = productionRegionJobRunnerDependencies,
): Promise<RegionAnalysisResult> {
  throwIfAborted(abortController.signal);
  state.chapter = await dependencies.openChapter(request.chapterId);
  throwIfAborted(abortController.signal);
  const page = state.chapter.pages.find(
    (candidate) => candidate.id === request.pageId,
  );
  const pageIndex = state.chapter.pages.findIndex(
    (candidate) => candidate.id === request.pageId,
  );
  if (!page) {
    return emitMissingRegionPage(id, emit, state.chapter);
  }

  state.runPaths = await dependencies.getRunPaths(request.chapterId, id);
  throwIfAborted(abortController.signal);
  const { cropPage, cropRect } = await dependencies.createRegionCropPage(
    page,
    request.bbox,
    id,
    state.runPaths.runDir,
    context.decodeImage,
    abortController.signal,
  );
  throwIfAborted(abortController.signal);
  emitRegionStarting(id, emit, cropRect);
  if (request.pageRevision && createPageRevision(page) !== request.pageRevision)
    throw new Error("페이지가 변경되었습니다. 영역을 다시 선택해 주세요.");
  const result = await runRegionPipeline({
    abortController,
    cropPage,
    cropRect,
    emit,
    id,
    page,
    pageIndex: Math.max(0, pageIndex),
    request,
    runPaths: state.runPaths,
    registerResourceCleanup,
    dependencies,
  });

  throwIfAborted(abortController.signal);
  return completeRegionTranslation({
    cropRect,
    cropPage,
    context,
    directory: state.runPaths.runDir,
    emit,
    id,
    page,
    request,
    result,
    signal: abortController.signal,
    appendBlocks: dependencies.appendAnalyzedPageBlocks,
  });
}

export async function handleRegionJobError({
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
  request: RegionAnalysisRequest;
  state: RegionJobState;
  context: TranslationJobContext;
}): Promise<RegionAnalysisResult> {
  const lastEvent = getLastJobEvent(context, id);
  if (abortController.signal.reason?.code === "CODEX_DISCONNECTED")
    return handleRegionFailure(
      id,
      emit,
      request,
      state,
      lastEvent,
      abortController.signal.reason,
    );
  if (isAbortError(error) || abortController.signal.aborted) {
    return handleRegionAbort(id, emit, request, state, lastEvent);
  }
  return handleRegionFailure(id, emit, request, state, lastEvent, error);
}

function emitMissingRegionPage(
  id: string,
  emit: EmitJobEvent,
  chapter: OpenedChapter,
): RegionAnalysisResult {
  emit({
    id,
    kind: "gemma-analysis",
    status: "failed",
    progressText: tMain("region.failed"),
    phase: "failed",
    detail: tMain("region.pageNotFound"),
  });
  return {
    status: "failed",
    chapter,
    error: tMain("region.pageNotFound"),
  };
}

function emitRegionStarting(
  id: string,
  emit: EmitJobEvent,
  cropRect: { w: number; h: number },
): void {
  emit({
    id,
    kind: "gemma-analysis",
    status: "starting",
    progressText: tMain("region.preparing"),
    phase: "booting",
    progressCurrent: 0,
    progressTotal: 1,
    pageTotal: 1,
    detail: `${Math.round(cropRect.w)} x ${Math.round(cropRect.h)} px`,
  });
}

async function runRegionPipeline({
  abortController,
  cropPage,
  cropRect,
  emit,
  id,
  page,
  pageIndex,
  request,
  runPaths,
  registerResourceCleanup,
  dependencies,
}: {
  abortController: AbortController;
  cropPage: MangaPage;
  cropRect: Parameters<typeof mapRegionBlocksToPageBlocks>[2];
  emit: EmitJobEvent;
  id: string;
  page: MangaPage;
  pageIndex: number;
  request: RegionAnalysisRequest;
  runPaths: ChapterRunPaths;
  registerResourceCleanup: (cleanup: JobResourceCleanup) => void;
  dependencies: RegionJobRunnerDependencies;
}): Promise<PipelineResult> {
  const workContext = await dependencies.resolveWorkContextForChapter(
    request.chapterId,
  );
  throwIfAborted(abortController.signal);
  return dependencies.runWholePagePipeline({
    jobId: id,
    emit,
    onCleanupReady: registerResourceCleanup,
    pages: [cropPage],
    runPaths,
    signal: abortController.signal,
    regionContext: {
      sourcePage: page,
      sourcePageIndex: pageIndex,
      cropRect,
    },
    workContext: {
      ...workContext,
      chapterId: request.chapterId,
      recentPageCount: 6,
    },
    writeStoryMemory: false,
    confirmRegionReading: regionReadingReview(
      request,
      id,
      abortController.signal,
      emit,
    ),
    codexTypesetting: request.codexTypesetting
      ? {
          ...request.codexTypesetting,
          eraseOriginal: request.eraseOriginal === true,
        }
      : undefined,
  });
}

async function handleRegionAbort(
  id: string,
  emit: EmitJobEvent,
  request: RegionAnalysisRequest,
  state: RegionJobState,
  lastEvent: JobEvent | undefined,
): Promise<RegionAnalysisResult> {
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
      () => state.chapter ?? undefined,
    ),
    pageId: request.pageId,
  };
}

async function handleRegionFailure(
  id: string,
  emit: EmitJobEvent,
  request: RegionAnalysisRequest,
  state: RegionJobState,
  lastEvent: JobEvent | undefined,
  error: unknown,
): Promise<RegionAnalysisResult> {
  const message = error instanceof Error ? error.message : String(error);
  logError("Region translation job failed", {
    jobId: id,
    request,
    runPaths: state.runPaths,
    lastEvent,
    error,
  });
  emitFailedRegionJob(
    id,
    emit,
    lastEvent,
    message,
    readJobFailureGuidance(error),
  );
  return {
    status: "failed",
    error: message,
    failureGuidance: readJobFailureGuidance(error),
    chapter: await openChapter(request.chapterId).catch(
      () => state.chapter ?? undefined,
    ),
    pageId: request.pageId,
  };
}

function emitFailedRegionJob(
  id: string,
  emit: EmitJobEvent,
  lastEvent: JobEvent | undefined,
  message: string,
  failureGuidance?: JobFailureGuidance,
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
    failureGuidance,
  });
}

function getLastJobEvent(
  context: TranslationJobContext,
  id: string,
): JobEvent | undefined {
  return context.jobs.current?.id === id
    ? context.jobs.current.lastEvent
    : undefined;
}

function regionReadingReview(
  request: RegionAnalysisRequest,
  id: string,
  signal: AbortSignal,
  emit: EmitJobEvent,
) {
  const sessionId = request.textReviewSessionId;
  if (!sessionId || !request.codexTypesetting) return undefined;
  return (reading: Parameters<typeof waitForRegionTextReview>[0]["reading"]) =>
    waitForRegionTextReview({
      jobId: id,
      sessionId,
      reading,
      signal,
      show: (regionTextReview) =>
        emit({
          id,
          kind: "gemma-analysis",
          status: "running",
          phase: "model_requesting",
          progressText: "번역문 확인",
          codexProgress: {
            stage: "reading",
            step: "confirmText",
            completed: 0,
            total: 1,
            page: 1,
          },
          pageIndex: 1,
          pageTotal: 1,
          regionTextReview,
        }),
    });
}
