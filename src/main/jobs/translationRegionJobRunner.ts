import type {
  RegionAnalysisRequest,
  RegionAnalysisResult,
} from "../../shared/analysisTypes";
import type { JobEvent } from "../../shared/jobTypes";
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
import { isAbortError } from "./jobEvents";
import type { TranslationJobContext } from "./translationJobTypes";

type EmitJobEvent = (event: JobEvent) => void;
type ChapterRunPaths = Awaited<ReturnType<typeof getRunPaths>>;
type OpenedChapter = Awaited<ReturnType<typeof openChapter>>;
type PipelineResult = Awaited<ReturnType<typeof runWholePagePipeline>>;

export type RegionJobState = {
  chapter: OpenedChapter | null;
  runPaths: ChapterRunPaths | null;
};

export async function runRegionTranslationJob({
  context,
  request,
  id,
  abortController,
  emit,
  state,
}: {
  context: TranslationJobContext;
  request: RegionAnalysisRequest;
  id: string;
  abortController: AbortController;
  emit: EmitJobEvent;
  state: RegionJobState;
}): Promise<RegionAnalysisResult> {
  state.chapter = await openChapter(request.chapterId);
  const page = state.chapter.pages.find(
    (candidate) => candidate.id === request.pageId,
  );
  const pageIndex = state.chapter.pages.findIndex(
    (candidate) => candidate.id === request.pageId,
  );
  if (!page) {
    return emitMissingRegionPage(id, emit, state.chapter);
  }

  state.runPaths = await getRunPaths(request.chapterId, id);
  const { cropPage, cropRect } = await createRegionCropPage(
    page,
    request.bbox,
    id,
    state.runPaths.runDir,
    context.decodeImage,
  );
  emitRegionStarting(id, emit, cropRect);
  const result = await runRegionPipeline({
    abortController,
    context,
    cropPage,
    cropRect,
    emit,
    id,
    page,
    pageIndex: Math.max(0, pageIndex),
    request,
    runPaths: state.runPaths,
  });

  if (abortController.signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  return completeRegionTranslation({
    cropRect,
    emit,
    id,
    page,
    request,
    result,
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

function runRegionPipeline({
  abortController,
  context,
  cropPage,
  cropRect,
  emit,
  id,
  page,
  pageIndex,
  request,
  runPaths,
}: {
  abortController: AbortController;
  context: TranslationJobContext;
  cropPage: MangaPage;
  cropRect: Parameters<typeof mapRegionBlocksToPageBlocks>[2];
  emit: EmitJobEvent;
  id: string;
  page: MangaPage;
  pageIndex: number;
  request: RegionAnalysisRequest;
  runPaths: ChapterRunPaths;
}): Promise<PipelineResult> {
  return resolveWorkContextForChapter(request.chapterId).then((workContext) =>
    runWholePagePipeline({
      jobId: id,
      emit,
      onCleanupReady: (cleanup) => {
        context.jobs.setCleanup(id, cleanup);
      },
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
    }),
  );
}

async function completeRegionTranslation({
  cropRect,
  emit,
  id,
  page,
  request,
  result,
}: {
  cropRect: Parameters<typeof mapRegionBlocksToPageBlocks>[2];
  emit: EmitJobEvent;
  id: string;
  page: MangaPage;
  request: RegionAnalysisRequest;
  result: PipelineResult;
}): Promise<RegionAnalysisResult> {
  const analyzedCrop = result.pages[0];
  const mappedBlocks = analyzedCrop
    ? mapRegionBlocksToPageBlocks(analyzedCrop.blocks, page, cropRect)
    : [];
  // 영역 번역은 새 블록을 덧붙이기만 하므로, 작업 중 사용자 편집이 저장됐어도
  // 최신 페이지 상태 위에 원자적으로 append해 충돌 없이 반영한다.
  const saved = await appendAnalyzedPageBlocks(
    request.chapterId,
    request.pageId,
    mappedBlocks,
  );
  emitRegionCompleted(id, emit, mappedBlocks.length);
  return {
    status: "completed",
    chapter: saved,
    warnings: result.warnings,
    pageId: request.pageId,
    blockIds: mappedBlocks.map((block) => block.id),
  };
}

function emitRegionCompleted(
  id: string,
  emit: EmitJobEvent,
  blockCount: number,
): void {
  emit({
    id,
    kind: "gemma-analysis",
    status: "completed",
    progressText: tMain("region.completed"),
    phase: "done",
    progressCurrent: 1,
    progressTotal: 1,
    pageTotal: 1,
    detail: tMain("units.blocks", { count: blockCount }),
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
  emitFailedRegionJob(id, emit, lastEvent, message);
  return {
    status: "failed",
    error: message,
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

function getLastJobEvent(
  context: TranslationJobContext,
  id: string,
): JobEvent | undefined {
  return context.jobs.current?.id === id
    ? context.jobs.current.lastEvent
    : undefined;
}
