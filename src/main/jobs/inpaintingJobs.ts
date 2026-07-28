import { randomUUID } from "node:crypto";
import type {
  AutoInpaintingChapterSelection,
  StartInpaintingRequest,
  StartInpaintingResult,
} from "../../shared/inpaintingTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { ChapterSnapshot } from "../../shared/libraryTypes";
import { tMain } from "./localization";
import {
  type InpaintingJobState,
  type InpaintingJobPage,
  handleInpaintingJobError,
  runInpaintingPagesJob,
} from "./inpaintingJobRunner";
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
  const state: InpaintingJobState = {
    chapter: null,
    chapters: new Map(),
    historyTransactionId:
      context.inpaintingRevisionStore?.beginTransaction() ?? null,
    inpaintingEngineLease: null,
    bubbleLayoutRunner: null,
    bubbleLayoutPostprocess: null,
  };
  context.jobs.start({
    id,
    kind: "inpainting",
    abortController,
    cleanup: () => completion.promise,
  });
  const emit = (event: JobEvent) =>
    runtime.emitEvent(context.jobs, context.getMainWindow(), event);

  try {
    const targets = await resolveInpaintingJobPages(request, state, runtime);
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
    finishInpaintingJob(context, state, id, completion.resolve);
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

function finishInpaintingJob(
  context: InpaintingJobContext,
  state: InpaintingJobState,
  id: string,
  resolveCompletion: () => void,
): void {
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
      context.jobs.clearIfCurrent(id);
      resolveCompletion();
    }
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
        ? chapter.pages.filter((page) => !page.inpaintedImagePath)
        : chapter.pages.filter((page) => page.id === request.pageId);
    return pages.map((page) => ({ chapterId: chapter.id, page }));
  }

  if (request.selections.length === 0) {
    throw new Error("At least one chapter selection is required.");
  }

  const targets: InpaintingJobPage[] = [];
  const selectedChapterIds = new Set<string>();
  for (const selection of request.selections) {
    if (selectedChapterIds.has(selection.chapterId)) {
      throw new Error("Duplicate chapter selections are not allowed.");
    }
    selectedChapterIds.add(selection.chapterId);

    const chapter = await runtime.openChapter(selection.chapterId);
    if (chapter.workId !== request.workId) {
      throw new Error("Selected chapters must belong to the same work.");
    }
    state.chapters.set(chapter.id, chapter);
    targets.push(...resolveSelectedChapterPages(chapter, selection));
  }
  return targets;
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
