import type {
  InpaintingMaskStroke,
  StartInpaintingRequest,
  StartInpaintingResult,
} from "../../shared/inpaintingTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { isAbortError } from "./jobEvents";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import type { InpaintingJobRuntime } from "./inpaintingJobRuntime";
import { saveInpaintingPageResult } from "./inpaintingJobHistory";
import {
  emitInpaintingCancelled,
  emitInpaintingCompleted,
  emitInpaintingFailed,
  emitInpaintingPageDone,
  emitInpaintingPageRunning,
  emitInpaintingStarting,
} from "./inpaintingJobProgress";

type EmitJobEvent = (event: JobEvent) => void;
type OpenedChapter = Awaited<ReturnType<InpaintingJobRuntime["openChapter"]>>;
type InpaintingEngineLease = Awaited<
  ReturnType<InpaintingJobRuntime["acquireEngine"]>
>;
type InpaintingPageResult = Awaited<
  ReturnType<InpaintingJobRuntime["inpaintPatternPage"]>
>;

export type InpaintingJobState = {
  chapter: OpenedChapter | null;
  chapters: Map<string, OpenedChapter>;
  historyTransactionId: string | null;
  inpaintingEngineLease: InpaintingEngineLease | null;
};

export type InpaintingJobPage = {
  chapterId: string;
  page: MangaPage;
};

type InpaintingTarget = {
  drawnPatternMode: boolean;
  drawnStrokes: InpaintingMaskStroke[];
  drawnFeatherPx?: number;
  targetType: "drawn" | "source";
};

export async function runInpaintingPagesJob({
  context,
  request,
  id,
  abortController,
  emit,
  targets,
  state,
  runtime,
}: {
  context: InpaintingJobContext;
  request: StartInpaintingRequest;
  id: string;
  abortController: AbortController;
  emit: EmitJobEvent;
  targets: InpaintingJobPage[];
  state: InpaintingJobState;
  runtime: InpaintingJobRuntime;
}): Promise<StartInpaintingResult> {
  const target = resolveInpaintingTarget(request);
  const totalTargetBlocks = countTargetBlocks(
    targets.map(({ page }) => page),
    target,
  );
  emitInpaintingStarting(id, emit, targets.length, totalTargetBlocks, target);
  const result = await processInpaintingPages({
    abortController,
    context,
    emit,
    id,
    targets,
    state,
    target,
    totalTargetBlocks,
    runtime,
  });

  emitInpaintingCompleted(
    id,
    emit,
    targets.length,
    result.blocksErased,
    target.targetType,
  );
  return {
    status: "completed",
    ...(request.mode === "selection-pattern"
      ? { chapters: result.savedChapters }
      : { chapter: result.savedChapters[0] }),
    pagesChanged: result.pagesChanged,
    blocksErased: result.blocksErased,
    historyTransaction: context.inpaintingRevisionStore?.getReference(
      state.historyTransactionId,
    ),
  };
}

export async function handleInpaintingJobError({
  abortController,
  emit,
  error,
  id,
  request,
  state,
  context,
  runtime,
}: {
  abortController: AbortController;
  emit: EmitJobEvent;
  error: unknown;
  id: string;
  request: StartInpaintingRequest;
  state: InpaintingJobState;
  context: InpaintingJobContext;
  runtime: InpaintingJobRuntime;
}): Promise<StartInpaintingResult> {
  const lastEvent = getLastJobEvent(context, id);
  if (isAbortError(error) || abortController.signal.aborted) {
    emitInpaintingCancelled(id, emit, lastEvent);
    const refreshed = await refreshRequestChapters(request, state, runtime);
    return {
      status: "cancelled",
      ...refreshed,
      historyTransaction: context.inpaintingRevisionStore?.getReference(
        state.historyTransactionId,
      ),
    };
  }

  const refreshed = await refreshRequestChapters(request, state, runtime);
  const message = error instanceof Error ? error.message : String(error);
  runtime.logError("Inpainting job failed", {
    jobId: id,
    request,
    lastEvent,
    error,
  });
  emitInpaintingFailed(id, emit, lastEvent, message);
  return {
    status: "failed",
    error: message,
    ...refreshed,
    historyTransaction: context.inpaintingRevisionStore?.getReference(
      state.historyTransactionId,
    ),
  };
}

async function refreshRequestChapters(
  request: StartInpaintingRequest,
  state: InpaintingJobState,
  runtime: InpaintingJobRuntime,
): Promise<Pick<StartInpaintingResult, "chapter" | "chapters">> {
  if (request.mode !== "selection-pattern") {
    return {
      chapter: await runtime
        .openChapter(request.chapterId)
        .catch(() => state.chapter ?? undefined),
    };
  }

  const chapters = await Promise.all(
    request.selections.map(async ({ chapterId }) =>
      runtime.openChapter(chapterId).catch(() => state.chapters.get(chapterId)),
    ),
  );
  return { chapters: chapters.filter((chapter) => chapter !== undefined) };
}

function resolveInpaintingTarget(
  request: StartInpaintingRequest,
): InpaintingTarget {
  if (request.mode === "page-pattern-drawn") {
    return {
      drawnPatternMode: true,
      drawnStrokes: request.strokes,
      drawnFeatherPx: request.featherPx,
      targetType: "drawn",
    };
  }
  return {
    drawnPatternMode: false,
    drawnStrokes: [],
    targetType: "source",
  };
}

function countTargetBlocks(
  pages: MangaPage[],
  target: InpaintingTarget,
): number {
  if (target.drawnPatternMode) {
    return target.drawnStrokes.length;
  }
  return pages.reduce((count, page) => count + page.blocks.length, 0);
}

async function processInpaintingPages({
  abortController,
  context,
  emit,
  id,
  targets,
  state,
  target,
  totalTargetBlocks,
  runtime,
}: {
  abortController: AbortController;
  context: InpaintingJobContext;
  emit: EmitJobEvent;
  id: string;
  targets: InpaintingJobPage[];
  state: InpaintingJobState;
  target: InpaintingTarget;
  totalTargetBlocks: number;
  runtime: InpaintingJobRuntime;
}): Promise<{
  savedChapters: OpenedChapter[];
  pagesChanged: number;
  blocksErased: number;
}> {
  let blocksErased = 0;
  let pagesChanged = 0;
  state.inpaintingEngineLease = await acquireInpaintingEngineIfNeeded({
    abortController,
    context,
    emit,
    id,
    pageCount: targets.length,
    totalTargetBlocks,
    runtime,
  });

  for (const [pageIndex, targetPage] of targets.entries()) {
    const result = await processInpaintingPage({
      abortController,
      context,
      emit,
      id,
      page: targetPage.page,
      pageIndex,
      pageCount: targets.length,
      state,
      target,
      runtime,
    });
    if (result.blocksErased <= 0) {
      continue;
    }
    blocksErased += result.blocksErased;
    pagesChanged += 1;
    const savedChapter = await saveInpaintingPageResult({
      context,
      resultPage: result.page,
      transactionId: state.historyTransactionId,
      chapterId: targetPage.chapterId,
      previousPage: targetPage.page,
      runtime,
    });
    state.chapters.set(targetPage.chapterId, savedChapter);
    if (state.chapter?.id === targetPage.chapterId) {
      state.chapter = savedChapter;
    }
  }

  return {
    savedChapters: [...state.chapters.values()],
    pagesChanged,
    blocksErased,
  };
}

async function acquireInpaintingEngineIfNeeded({
  abortController,
  context,
  emit,
  id,
  pageCount,
  totalTargetBlocks,
  runtime,
}: {
  abortController: AbortController;
  context: InpaintingJobContext;
  emit: EmitJobEvent;
  id: string;
  pageCount: number;
  totalTargetBlocks: number;
  runtime: InpaintingJobRuntime;
}): Promise<InpaintingEngineLease | null> {
  if (totalTargetBlocks <= 0) {
    return null;
  }
  const appSettings = await runtime.getSettings(context.appPaths);
  return runtime.acquireEngine({
    appPaths: context.appPaths,
    model: appSettings.inpainting?.model ?? "flux-klein",
    fluxBackend: appSettings.inpainting?.fluxBackend,
    koharuBackend: appSettings.inpainting?.koharuBackend,
    allowUnsafeLowMemoryFlux:
      appSettings.inpainting?.allowUnsafeLowMemoryFlux ?? false,
    signal: abortController.signal,
    onProgress: (progress) =>
      emit({
        id,
        kind: "inpainting",
        status: "starting",
        progressText: progress.progressText,
        phase: "model_downloading",
        progressCurrent: 0,
        progressTotal: pageCount,
        pageTotal: pageCount,
        detail: progress.detail,
        progressMode: progress.progressMode,
        progressPercent: progress.progressPercent,
        progressBytes: progress.progressBytes,
        progressTotalBytes: progress.progressTotalBytes,
        installLogLine: progress.installLogLine,
      }),
  });
}

async function processInpaintingPage({
  abortController,
  context,
  emit,
  id,
  page,
  pageIndex,
  pageCount,
  state,
  target,
  runtime,
}: {
  abortController: AbortController;
  context: InpaintingJobContext;
  emit: EmitJobEvent;
  id: string;
  page: MangaPage;
  pageIndex: number;
  pageCount: number;
  state: InpaintingJobState;
  target: InpaintingTarget;
  runtime: InpaintingJobRuntime;
}): Promise<InpaintingPageResult> {
  if (abortController.signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const pageTargetCount = target.drawnPatternMode
    ? target.drawnStrokes.length
    : page.blocks.length;
  emitInpaintingPageRunning(id, emit, page, pageIndex, pageCount, {
    pageTargetCount,
    target,
  });
  const result = target.drawnPatternMode
    ? await runtime.inpaintDrawnPage(page, {
        signal: abortController.signal,
        decodeFallback: context.decodeImage,
        inpaintingEngine: state.inpaintingEngineLease?.engine,
        strokes: target.drawnStrokes,
        featherPx: target.drawnFeatherPx,
      })
    : await runtime.inpaintPatternPage(page, {
        signal: abortController.signal,
        decodeFallback: context.decodeImage,
        inpaintingEngine: state.inpaintingEngineLease?.engine,
      });
  emitInpaintingPageDone(
    id,
    emit,
    pageIndex,
    pageCount,
    target,
    result.blocksErased,
  );
  return result;
}

function getLastJobEvent(
  context: InpaintingJobContext,
  id: string,
): JobEvent | undefined {
  return context.jobs.current?.id === id
    ? context.jobs.current.lastEvent
    : undefined;
}
