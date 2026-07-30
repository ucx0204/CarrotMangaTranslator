import type {
  StartInpaintingRequest,
  StartInpaintingResult,
} from "../../shared/inpaintingTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { AppSettings } from "../../shared/settingsTypes";
import { prepareBubbleLayoutJob } from "./bubbleLayoutJob";
import { isAbortError } from "./jobEvents";
import {
  processInpaintingPage,
  type InpaintingJobState,
  type InpaintingTarget,
} from "./inpaintingJobPageProcessor";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import type { InpaintingJobRuntime } from "./inpaintingJobRuntime";
import { saveInpaintingPageResult } from "./inpaintingJobHistory";
import {
  emitInpaintingCancelled,
  emitInpaintingCompleted,
  emitInpaintingFailed,
  emitInpaintingStarting,
} from "./inpaintingJobProgress";

type EmitJobEvent = (event: JobEvent) => void;
type OpenedChapter = Awaited<ReturnType<InpaintingJobRuntime["openChapter"]>>;
type InpaintingEngineLease = Awaited<
  ReturnType<InpaintingJobRuntime["acquireEngine"]>
>;

export type { InpaintingJobState };

export type InpaintingJobPage = {
  chapterId: string;
  page: MangaPage;
};

type ProcessInpaintingPagesResult = {
  savedChapters: OpenedChapter[];
  pagesChanged: number;
  blocksErased: number;
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
  assertRequestedBlockExists(targets, target);
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
    request,
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
  if (request.mode === "page-bubble-layout") {
    return {
      ...(request.blockId === undefined ? {} : { blockId: request.blockId }),
      drawnPatternMode: false,
      drawnStrokes: [],
      layoutOnly: true,
      targetType: "source",
    };
  }
  if (request.mode === "page-pattern-drawn") {
    return {
      drawnPatternMode: true,
      drawnStrokes: request.strokes,
      drawnFeatherPx: request.featherPx,
      layoutOnly: false,
      targetType: "drawn",
    };
  }
  const blockId = request.mode === "page-pattern" ? request.blockId : undefined;
  return {
    ...(blockId === undefined ? {} : { blockId }),
    drawnPatternMode: false,
    drawnStrokes: [],
    layoutOnly: false,
    targetType: "source",
  };
}

function countTargetBlocks(
  pages: MangaPage[],
  target: InpaintingTarget,
): number {
  if (target.blockId) {
    return 1;
  }
  if (target.drawnPatternMode) {
    return target.drawnStrokes.length;
  }
  return pages.reduce((count, page) => count + page.blocks.length, 0);
}

function assertRequestedBlockExists(
  targets: readonly InpaintingJobPage[],
  target: InpaintingTarget,
): void {
  if (!target.blockId) {
    return;
  }
  const page = targets[0]?.page;
  if (
    targets.length !== 1 ||
    !page?.blocks.some((block) => block.id === target.blockId)
  ) {
    throw new Error("선택한 텍스트 블록을 페이지에서 찾지 못했습니다.");
  }
}

async function processInpaintingPages({
  abortController,
  context,
  emit,
  id,
  request,
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
  request: StartInpaintingRequest;
  targets: InpaintingJobPage[];
  state: InpaintingJobState;
  target: InpaintingTarget;
  totalTargetBlocks: number;
  runtime: InpaintingJobRuntime;
}): Promise<ProcessInpaintingPagesResult> {
  let blocksErased = 0;
  let pagesChanged = 0;
  const preparedBubbleLayout = await prepareBubbleLayoutJob({
    context,
    request,
    runtime,
    totalTargetBlocks,
  });
  const { appSettings } = preparedBubbleLayout;
  state.bubbleLayoutPostprocess = preparedBubbleLayout.config;
  state.bubbleLayoutRunner = preparedBubbleLayout.runner;
  state.inpaintingEngineLease = await acquireInpaintingEngineIfNeeded({
    abortController,
    appSettings,
    context,
    emit,
    id,
    shouldAcquireEngine: !target.layoutOnly,
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
      result,
      transactionId: state.historyTransactionId,
      targetPage,
      runtime,
    });
    recordSavedChapter(state, targetPage.chapterId, savedChapter);
  }

  return {
    savedChapters: [...state.chapters.values()],
    pagesChanged,
    blocksErased,
  };
}

function recordSavedChapter(
  state: InpaintingJobState,
  chapterId: string,
  chapter: OpenedChapter,
): void {
  state.chapters.set(chapterId, chapter);
  if (state.chapter?.id === chapterId) {
    state.chapter = chapter;
  }
}

async function acquireInpaintingEngineIfNeeded({
  abortController,
  appSettings,
  context,
  emit,
  id,
  shouldAcquireEngine,
  pageCount,
  totalTargetBlocks,
  runtime,
}: {
  abortController: AbortController;
  appSettings: AppSettings | null;
  context: InpaintingJobContext;
  emit: EmitJobEvent;
  id: string;
  shouldAcquireEngine: boolean;
  pageCount: number;
  totalTargetBlocks: number;
  runtime: InpaintingJobRuntime;
}): Promise<InpaintingEngineLease | null> {
  if (!shouldAcquireEngine || totalTargetBlocks <= 0) {
    return null;
  }
  if (!appSettings) {
    return null;
  }
  return runtime.acquireEngine({
    appPaths: context.appPaths,
    model: appSettings.inpainting?.model ?? "flux-klein",
    fluxBackend: appSettings.inpainting?.fluxBackend,
    koharuBackend: appSettings.inpainting?.koharuBackend,
    computeGpuIndex: appSettings.hardware?.computeGpuIndex,
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

function getLastJobEvent(
  context: InpaintingJobContext,
  id: string,
): JobEvent | undefined {
  return context.jobs.current?.id === id
    ? context.jobs.current.lastEvent
    : undefined;
}
