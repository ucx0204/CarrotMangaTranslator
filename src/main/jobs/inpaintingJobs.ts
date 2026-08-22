import { randomUUID } from "node:crypto";
import type {
  AutoInpaintingChapterSelection,
  StartInpaintingRequest,
  StartInpaintingResult,
} from "../../shared/inpaintingTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { ChapterSnapshot } from "../../shared/libraryTypes";
import { createPageJobTargetSnapshot } from "../../shared/pageRevision";
import { tMain } from "./localization";
import {
  type InpaintingJobPage,
  handleInpaintingJobError,
  runInpaintingPagesJob,
} from "./inpaintingJobRunner";
import type { InpaintingJobState } from "./inpaintingJobPageTypes";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import {
  productionInpaintingJobRuntime,
  type InpaintingJobRuntime,
} from "./inpaintingJobRuntime";

export type { InpaintingJobContext } from "./inpaintingJobTypes";

export async function startInpaintingJob(
  context: InpaintingJobContext,
  request: StartInpaintingRequest,
  runtime: InpaintingJobRuntime = productionInpaintingJobRuntime,
): Promise<StartInpaintingResult> {
  if (context.jobs.hasActive) {
    return { status: "failed", error: tMain("jobs.active") };
  }

  const id = randomUUID();
  const abortController = new AbortController();
  const completion = createInpaintingJobCompletion();
  const state = createInpaintingJobState(context, request);
  context.jobs.start({
    id,
    kind: "inpainting",
    abortController,
    cleanup: () => completion.promise,
  });
  const emit = (event: JobEvent) =>
    runtime.emitEvent(context.jobs, context.getMainWindow(), {
      ...event,
      ...(state.targetSnapshots.length > 0
        ? { targets: state.targetSnapshots }
        : {}),
    });

  try {
    const targets = await resolveInpaintingJobPages(request, state, runtime);
    inferRequestedCompletionWorkflow(request, state, targets);
    recordInpaintingTargetPages(state, targets);
    if (targets.length === 0) {
      emit({
        id,
        kind: "inpainting",
        status: "failed",
        progressText: tMain("inpainting.failed"),
        phase: "failed",
        progressCurrent: 0,
        progressTotal: 0,
        pageTotal: 0,
        detail: tMain("inpainting.pageNotFound"),
      });
      return {
        status: "failed",
        ...(request.mode === "selection-pattern"
          ? { chapters: [...state.chapters.values()] }
          : { chapter: state.chapter ?? undefined }),
        error: tMain("inpainting.pageNotFound"),
        pagesChanged: state.pagesChanged,
        blocksErased: state.blocksErased,
        pagesIncomplete: state.pagesIncomplete,
        blocksIncomplete: state.blocksIncomplete,
      };
    }
    return await runInpaintingPagesJob({
      context,
      request,
      id,
      abortController,
      emit,
      targets,
      state,
      runtime,
    });
  } catch (error) {
    return await handleInpaintingJobError({
      abortController,
      emit,
      error,
      id,
      request,
      state,
      context,
      runtime,
    });
  } finally {
    await finishInpaintingJob(context, state, id, completion.resolve, runtime);
  }
}

function createInpaintingJobState(
  context: InpaintingJobContext,
  request: StartInpaintingRequest,
): InpaintingJobState {
  return {
    chapter: null,
    chapters: new Map(),
    historyTransactionId:
      context.inpaintingRevisionStore?.beginTransaction() ?? null,
    inpaintingEngineLease: null,
    bubbleLayoutRunner: null,
    bubbleLayoutPostprocess: null,
    pagesChanged: 0,
    pagesIncomplete: 0,
    blocksErased: 0,
    blocksIncomplete: 0,
    targetPageIds: new Map(),
    targetSnapshots: [],
    ...resolveRequestedCompletionWorkflow(request),
  };
}

function resolveRequestedCompletionWorkflow(
  request: StartInpaintingRequest,
): Pick<InpaintingJobState, "requestedCompletionWorkflow"> {
  if (
    request.mode === "page-bubble-layout" ||
    request.postprocess?.bubbleLayout?.enabled === true
  ) {
    return { requestedCompletionWorkflow: "bubble-layout" };
  }
  if (request.postprocess?.bubbleLayout?.enabled === false) {
    return { requestedCompletionWorkflow: "erase-original" };
  }
  return {};
}

function inferRequestedCompletionWorkflow(
  request: StartInpaintingRequest,
  state: InpaintingJobState,
  targets: readonly InpaintingJobPage[],
): void {
  if (!canInferFullPageCompletionWorkflow(request)) return;
  const workflows = new Set(
    targets.flatMap(({ page }) =>
      page.translationCompletion ? [page.translationCompletion.workflow] : [],
    ),
  );
  if (workflows.size > 1) {
    throw new Error(tMain("inpainting.mixedCompletionWorkflows"));
  }
  const inferredWorkflow = [...workflows][0];
  if (
    state.requestedCompletionWorkflow &&
    inferredWorkflow &&
    targets.some(
      ({ page }) =>
        page.translationCompletion?.status === "pending" &&
        page.translationCompletion.workflow !==
          state.requestedCompletionWorkflow,
    )
  ) {
    throw new Error(tMain("inpainting.mixedCompletionWorkflows"));
  }
  if (state.requestedCompletionWorkflow) return;
  if (workflows.size === 1) {
    state.requestedCompletionWorkflow = inferredWorkflow;
  }
}

function canInferFullPageCompletionWorkflow(
  request: StartInpaintingRequest,
): boolean {
  return (
    request.mode === "selection-pattern" ||
    request.mode === "chapter-pattern-pending" ||
    (request.mode === "page-pattern" && request.blockId === undefined)
  );
}

function recordInpaintingTargetPages(
  state: InpaintingJobState,
  targets: readonly InpaintingJobPage[],
): void {
  for (const target of targets) {
    const pageIds = state.targetPageIds.get(target.chapterId) ?? new Set();
    pageIds.add(target.page.id);
    state.targetPageIds.set(target.chapterId, pageIds);
    state.targetSnapshots.push(
      createPageJobTargetSnapshot(target.chapterId, target.page),
    );
  }
}

function createInpaintingJobCompletion(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolveCompletion!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  return { promise, resolve: resolveCompletion };
}

async function finishInpaintingJob(
  context: InpaintingJobContext,
  state: InpaintingJobState,
  id: string,
  resolveCompletion: () => void,
  runtime: InpaintingJobRuntime,
): Promise<void> {
  try {
    if (state.historyTransactionId) {
      context.inpaintingRevisionStore?.discardIfEmpty(
        state.historyTransactionId,
      );
    }
  } finally {
    try {
      state.inpaintingEngineLease?.release();
    } finally {
      try {
        await disposeBubbleLayoutSessions(runtime);
      } finally {
        context.jobs.clearIfCurrent(id);
        resolveCompletion();
      }
    }
  }
}

async function disposeBubbleLayoutSessions(
  runtime: InpaintingJobRuntime,
): Promise<void> {
  try {
    await runtime.disposeBubbleLayoutSessions?.();
  } catch (error) {
    runtime.logError("Failed to release KoharuLayout sessions after job", {
      error,
    });
  }
}

async function resolveInpaintingJobPages(
  request: StartInpaintingRequest,
  state: InpaintingJobState,
  runtime: InpaintingJobRuntime,
): Promise<InpaintingJobPage[]> {
  if (request.mode !== "selection-pattern") {
    const chapter = await runtime.openChapter(request.chapterId);
    state.chapter = chapter;
    state.chapters.set(chapter.id, chapter);
    const pages =
      request.mode === "chapter-pattern-pending"
        ? chapter.pages.filter(
            (page) =>
              !page.inpaintedImagePath ||
              (page.translationCompletion !== undefined &&
                page.translationCompletion.status !== "completed"),
          )
        : chapter.pages.filter((page) => page.id === request.pageId);
    return pages.map((page) => ({ chapterId: chapter.id, page }));
  }

  if (request.selections.length !== 1) {
    throw new Error("Exactly one chapter selection is required.");
  }

  const selection = request.selections[0];
  if (!selection) {
    throw new Error("Exactly one chapter selection is required.");
  }
  const chapter = await runtime.openChapter(selection.chapterId);
  if (chapter.workId !== request.workId) {
    throw new Error("The selected chapter must belong to the requested work.");
  }
  state.chapters.set(chapter.id, chapter);
  return resolveSelectedChapterPages(chapter, selection);
}

function resolveSelectedChapterPages(
  chapter: ChapterSnapshot,
  selection: AutoInpaintingChapterSelection,
): InpaintingJobPage[] {
  if (selection.mode === "all") {
    return chapter.pages.map((page) => ({ chapterId: chapter.id, page }));
  }
  if (selection.pageIds.length === 0) {
    throw new Error("At least one page selection is required.");
  }

  const selectedPageIds = new Set<string>();
  for (const pageId of selection.pageIds) {
    if (selectedPageIds.has(pageId)) {
      throw new Error("Duplicate page selections are not allowed.");
    }
    selectedPageIds.add(pageId);
  }
  const knownPageIds = new Set(chapter.pages.map((page) => page.id));
  for (const pageId of selectedPageIds) {
    if (!knownPageIds.has(pageId)) {
      throw new Error("The selected page does not belong to the chapter.");
    }
  }
  return chapter.pages.flatMap((page) =>
    selectedPageIds.has(page.id) ? [{ chapterId: chapter.id, page }] : [],
  );
}
