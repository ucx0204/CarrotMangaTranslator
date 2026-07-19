import type {
  InpaintingMaskStroke,
  StartInpaintingRequest,
  StartInpaintingResult,
} from "../../shared/inpaintingTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { BubbleDetectionMode } from "../../shared/inpaintingSettingsTypes";
import { inpaintDrawnPatternPage, inpaintPatternPage } from "../inpainting";
import type { BubbleSegmentationEngineLease } from "../inpainting/bubbleSegmentationEnginePool";
import { acquireInpaintingEngine } from "../inpainting/inpaintingEnginePool";
import { openChapter } from "../library";
import { logError } from "../logger";
import { getAppSettings } from "../settingsStore";
import { isAbortError } from "./jobEvents";
import { prepareBubbleSegmentation } from "./inpaintingBubbleSegmentation";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
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
type OpenedChapter = Awaited<ReturnType<typeof openChapter>>;
type InpaintingEngineLease = Awaited<
  ReturnType<typeof acquireInpaintingEngine>
>;
type InpaintingPageResult = Awaited<ReturnType<typeof inpaintPatternPage>>;

export type InpaintingJobState = {
  chapter: OpenedChapter | null;
  chapters: Map<string, OpenedChapter>;
  historyTransactionId: string | null;
  inpaintingEngineLease: InpaintingEngineLease | null;
  bubbleSegmentationEngineLease: BubbleSegmentationEngineLease | null;
  bubbleDetectionMode: BubbleDetectionMode;
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
}: {
  context: InpaintingJobContext;
  request: StartInpaintingRequest;
  id: string;
  abortController: AbortController;
  emit: EmitJobEvent;
  targets: InpaintingJobPage[];
  state: InpaintingJobState;
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
}: {
  abortController: AbortController;
  emit: EmitJobEvent;
  error: unknown;
  id: string;
  request: StartInpaintingRequest;
  state: InpaintingJobState;
  context: InpaintingJobContext;
}): Promise<StartInpaintingResult> {
  const lastEvent = getLastJobEvent(context, id);
  const refreshed = await refreshRequestChapters(request, state);
  if (isAbortError(error) || abortController.signal.aborted) {
    emitInpaintingCancelled(id, emit, lastEvent);
    return {
      status: "cancelled",
      ...refreshed,
      historyTransaction: context.inpaintingRevisionStore?.getReference(
        state.historyTransactionId,
      ),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  logError("Inpainting job failed", {
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
): Promise<Pick<StartInpaintingResult, "chapter" | "chapters">> {
  if (request.mode !== "selection-pattern") {
    return {
      chapter: await openChapter(request.chapterId).catch(
        () => state.chapter ?? undefined,
      ),
    };
  }

  const chapters = await Promise.all(
    request.selections.map(async ({ chapterId }) =>
      openChapter(chapterId).catch(() => state.chapters.get(chapterId)),
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
}: {
  abortController: AbortController;
  context: InpaintingJobContext;
  emit: EmitJobEvent;
  id: string;
  targets: InpaintingJobPage[];
  state: InpaintingJobState;
  target: InpaintingTarget;
  totalTargetBlocks: number;
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
  });
  const bubbleSegmentation = await prepareBubbleSegmentation({
    abortController,
    context,
    emit,
    id,
    pageCount: targets.length,
    shouldPrepare: !target.drawnPatternMode && totalTargetBlocks > 0,
  });
  state.bubbleDetectionMode = bubbleSegmentation.mode;
  state.bubbleSegmentationEngineLease = bubbleSegmentation.lease;

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
}: {
  abortController: AbortController;
  context: InpaintingJobContext;
  emit: EmitJobEvent;
  id: string;
  pageCount: number;
  totalTargetBlocks: number;
}): Promise<InpaintingEngineLease | null> {
  if (totalTargetBlocks <= 0) {
    return null;
  }
  const appSettings = await getAppSettings(context.appPaths);
  return acquireInpaintingEngine({
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
    ? await inpaintDrawnPatternPage(page, {
        signal: abortController.signal,
        decodeFallback: context.decodeImage,
        inpaintingEngine: state.inpaintingEngineLease?.engine,
        strokes: target.drawnStrokes,
        featherPx: target.drawnFeatherPx,
      })
    : await inpaintPatternPage(page, {
        bubbleDetectionMode: state.bubbleDetectionMode,
        bubbleSegmentationEngine: state.bubbleSegmentationEngineLease?.engine,
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
