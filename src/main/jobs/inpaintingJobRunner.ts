import type {
  StartInpaintingRequest,
  StartInpaintingResult,
} from "../../shared/inpaintingTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { prepareBubbleLayoutJob } from "./bubbleLayoutJob";
import {
  assertInpaintingJobHasTargets,
  markFailedTranslationCompletions,
  refreshInpaintingRequestChapters,
} from "./inpaintingJobCompletion";
import { isAbortError } from "./jobEvents";
import { processInpaintingPage } from "./inpaintingJobPageProcessor";
import { countInpaintingPageTargets } from "./inpaintingJobPageCompletion";
import type {
  InpaintingJobState,
  InpaintingTarget,
} from "./inpaintingJobPageTypes";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import type { InpaintingJobRuntime } from "./inpaintingJobRuntime";
import { commitProcessedInpaintingPage } from "./inpaintingJobHistory";
import { acquireInpaintingEngineIfNeeded } from "./inpaintingJobEngine";
import {
  emitInpaintingCancelled,
  emitInpaintingCompleted,
  emitInpaintingFailed,
  emitInpaintingPartial,
  emitInpaintingStarting,
} from "./inpaintingJobProgress";
import {
  createPageProcessingTimingCollector,
  measureSharedProcessingStage,
} from "../pipeline/pageProcessingTiming";

type EmitJobEvent = (event: JobEvent) => void;
type OpenedChapter = Awaited<ReturnType<InpaintingJobRuntime["openChapter"]>>;

export type InpaintingJobPage = {
  chapterId: string;
  page: MangaPage;
};

type ProcessInpaintingPagesResult = {
  savedChapters: OpenedChapter[];
  pagesChanged: number;
  pagesIncomplete: number;
  blocksErased: number;
  blocksIncomplete: number;
};

type ProcessInpaintingPagesOptions = {
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
    state,
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

  if (result.pagesIncomplete > 0) {
    emitInpaintingPartial(
      id,
      emit,
      targets.length,
      result.pagesIncomplete,
      result.blocksErased,
      result.blocksIncomplete,
      target.targetType,
    );
  } else {
    emitInpaintingCompleted(
      id,
      emit,
      targets.length,
      result.blocksErased,
      target.targetType,
    );
  }
  return {
    status: result.pagesIncomplete > 0 ? "partial" : "completed",
    ...(request.mode === "selection-pattern"
      ? { chapters: result.savedChapters }
      : { chapter: result.savedChapters[0] }),
    pagesChanged: result.pagesChanged,
    blocksErased: result.blocksErased,
    pagesIncomplete: result.pagesIncomplete,
    blocksIncomplete: result.blocksIncomplete,
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
    const refreshed = await refreshInpaintingRequestChapters(
      request,
      state,
      runtime,
    );
    emitInpaintingCancelled(id, emit, lastEvent);
    return {
      status: "cancelled",
      ...refreshed,
      pagesChanged: state.pagesChanged,
      blocksErased: state.blocksErased,
      pagesIncomplete: state.pagesIncomplete,
      blocksIncomplete: state.blocksIncomplete,
      historyTransaction: context.inpaintingRevisionStore?.getReference(
        state.historyTransactionId,
      ),
    };
  }

  await markFailedTranslationCompletions(request, state, runtime);
  const refreshed = await refreshInpaintingRequestChapters(
    request,
    state,
    runtime,
  );
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
    pagesChanged: state.pagesChanged,
    blocksErased: state.blocksErased,
    pagesIncomplete: state.pagesIncomplete,
    blocksIncomplete: state.blocksIncomplete,
    historyTransaction: context.inpaintingRevisionStore?.getReference(
      state.historyTransactionId,
    ),
  };
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
  state: InpaintingJobState,
  target: InpaintingTarget,
): number {
  return pages.reduce(
    (count, page) => count + countInpaintingPageTargets(page, state, target),
    0,
  );
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
}: ProcessInpaintingPagesOptions): Promise<ProcessInpaintingPagesResult> {
  const timing = await prepareInpaintingPageRuntime({
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
      timing,
    });
    await commitProcessedInpaintingPage({
      context,
      result,
      targetPage,
      runtime,
      state,
    });
  }

  return {
    savedChapters: [...state.chapters.values()],
    pagesChanged: state.pagesChanged,
    pagesIncomplete: state.pagesIncomplete,
    blocksErased: state.blocksErased,
    blocksIncomplete: state.blocksIncomplete,
  };
}

async function prepareInpaintingPageRuntime({
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
}: ProcessInpaintingPagesOptions) {
  const timingChapterId = targets[0]?.chapterId;
  if (!timingChapterId) {
    throw new Error("Inpainting timing requires at least one target page.");
  }
  const timing = request.timingSession
    ? await runtime.openPageTimingSession({
        chapterId: timingChapterId,
        getMainWindow: context.getMainWindow,
        jobId: id,
        kind: "inpainting",
        pages: targets.map(({ page }) => page),
        session: request.timingSession,
      })
    : createPageProcessingTimingCollector(
        id,
        targets.map(({ page }) => page.id),
      );
  const preparedBubbleLayout = await measureSharedProcessingStage(
    timing,
    "preparing",
    () =>
      prepareBubbleLayoutJob({
        completionWorkflow: state.requestedCompletionWorkflow,
        context,
        request,
        runtime,
        totalTargetBlocks,
      }),
  );
  const { appSettings } = preparedBubbleLayout;
  state.bubbleLayoutPostprocess = preparedBubbleLayout.config;
  state.bubbleLayoutRunner = preparedBubbleLayout.runner;
  assertInpaintingJobHasTargets(targets, state, target, totalTargetBlocks);
  state.inpaintingEngineLease = await measureSharedProcessingStage(
    timing,
    "preparing",
    () =>
      acquireInpaintingEngineIfNeeded({
        abortController,
        appSettings,
        context,
        emit,
        id,
        shouldAcquireEngine: !target.layoutOnly,
        pageCount: targets.length,
        totalTargetBlocks,
        runtime,
      }),
  );
  return timing;
}

function getLastJobEvent(
  context: InpaintingJobContext,
  id: string,
): JobEvent | undefined {
  return context.jobs.current?.id === id
    ? context.jobs.current.lastEvent
    : undefined;
}
