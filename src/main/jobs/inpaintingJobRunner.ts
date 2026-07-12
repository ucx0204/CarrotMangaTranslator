import type {
  InpaintingMaskStroke,
  StartInpaintingRequest,
  StartInpaintingResult,
} from "../../shared/inpaintingTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { inpaintDrawnPatternPage, inpaintPatternPage } from "../inpainting";
import { acquireInpaintingEngine } from "../inpainting/inpaintingEnginePool";
import { openChapter, updatePagesAfterInpainting } from "../library";
import { logError } from "../logger";
import { getAppSettings } from "../settingsStore";
import { isAbortError } from "./jobEvents";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
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
  inpaintingEngineLease: InpaintingEngineLease | null;
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
  pages,
  state,
}: {
  context: InpaintingJobContext;
  request: StartInpaintingRequest;
  id: string;
  abortController: AbortController;
  emit: EmitJobEvent;
  pages: MangaPage[];
  state: InpaintingJobState;
}): Promise<StartInpaintingResult> {
  const target = resolveInpaintingTarget(request);
  const totalTargetBlocks = countTargetBlocks(pages, target);
  emitInpaintingStarting(id, emit, pages.length, totalTargetBlocks, target);
  const result = await processInpaintingPages({
    abortController,
    context,
    emit,
    id,
    pages,
    request,
    state,
    target,
    totalTargetBlocks,
  });

  emitInpaintingCompleted(
    id,
    emit,
    pages.length,
    result.blocksErased,
    target.targetType,
  );
  return {
    status: "completed",
    chapter: result.savedChapter,
    pagesChanged: result.pagesChanged,
    blocksErased: result.blocksErased,
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
  if (isAbortError(error) || abortController.signal.aborted) {
    emitInpaintingCancelled(id, emit, lastEvent);
    return {
      status: "cancelled",
      chapter: await openChapter(request.chapterId).catch(
        () => state.chapter ?? undefined,
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
    chapter: await openChapter(request.chapterId).catch(
      () => state.chapter ?? undefined,
    ),
  };
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
  pages,
  request,
  state,
  target,
  totalTargetBlocks,
}: {
  abortController: AbortController;
  context: InpaintingJobContext;
  emit: EmitJobEvent;
  id: string;
  pages: MangaPage[];
  request: StartInpaintingRequest;
  state: InpaintingJobState;
  target: InpaintingTarget;
  totalTargetBlocks: number;
}): Promise<{
  savedChapter: OpenedChapter;
  pagesChanged: number;
  blocksErased: number;
}> {
  let blocksErased = 0;
  let savedChapter = state.chapter;
  let pagesChanged = 0;
  state.inpaintingEngineLease = await acquireInpaintingEngineIfNeeded({
    abortController,
    context,
    emit,
    id,
    pageCount: pages.length,
    totalTargetBlocks,
  });

  for (const [pageIndex, page] of pages.entries()) {
    const result = await processInpaintingPage({
      abortController,
      context,
      emit,
      id,
      page,
      pageIndex,
      pages,
      state,
      target,
    });
    if (result.blocksErased > 0) {
      blocksErased += result.blocksErased;
      pagesChanged += 1;
      savedChapter = await updatePagesAfterInpainting(request.chapterId, [
        result.page,
      ]);
    }
  }

  return {
    savedChapter: savedChapter ?? (await openChapter(request.chapterId)),
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
  pages,
  state,
  target,
}: {
  abortController: AbortController;
  context: InpaintingJobContext;
  emit: EmitJobEvent;
  id: string;
  page: MangaPage;
  pageIndex: number;
  pages: MangaPage[];
  state: InpaintingJobState;
  target: InpaintingTarget;
}): Promise<InpaintingPageResult> {
  if (abortController.signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const pageTargetCount = target.drawnPatternMode
    ? target.drawnStrokes.length
    : page.blocks.length;
  emitInpaintingPageRunning(id, emit, page, pageIndex, pages.length, {
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
        signal: abortController.signal,
        decodeFallback: context.decodeImage,
        inpaintingEngine: state.inpaintingEngineLease?.engine,
      });
  emitInpaintingPageDone(
    id,
    emit,
    pageIndex,
    pages.length,
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
