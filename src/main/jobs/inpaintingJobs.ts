import { randomUUID } from "node:crypto";
import type {
  InpaintingExportRequest,
  InpaintingExportResult,
  StartInpaintingRequest,
  StartInpaintingResult,
} from "../../shared/inpaintingTypes";
import type { JobEvent } from "../../shared/jobTypes";
import { openChapter } from "../library";
import { tMain } from "./localization";
import {
  handleInpaintingExportError,
  runInpaintingExportJob,
} from "./inpaintingExportJobRunner";
import {
  type InpaintingJobState,
  handleInpaintingJobError,
  runInpaintingPagesJob,
} from "./inpaintingJobRunner";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import { emitJobEvent } from "./jobEvents";

export type { InpaintingJobContext } from "./inpaintingJobTypes";

export async function startInpaintingJob(
  context: InpaintingJobContext,
  request: StartInpaintingRequest,
): Promise<StartInpaintingResult> {
  if (context.jobs.hasActive) {
    return { status: "failed", error: tMain("jobs.active") };
  }

  const id = randomUUID();
  const abortController = new AbortController();
  const state: InpaintingJobState = {
    chapter: null,
    inpaintingEngineLease: null,
  };
  context.jobs.start({ id, kind: "inpainting", abortController });
  const emit = (event: JobEvent) =>
    emitJobEvent(context.jobs, context.getMainWindow(), event);

  try {
    state.chapter = await openChapter(request.chapterId);
    const pages =
      request.mode === "chapter-pattern-pending"
        ? state.chapter.pages.filter((page) => !page.inpaintedImagePath)
        : state.chapter.pages.filter((page) => page.id === request.pageId);
    if (pages.length === 0) {
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
        chapter: state.chapter,
        error: tMain("inpainting.pageNotFound"),
      };
    }
    return await runInpaintingPagesJob({
      context,
      request,
      id,
      abortController,
      emit,
      pages,
      state,
    });
  } catch (error) {
    return handleInpaintingJobError({
      abortController,
      emit,
      error,
      id,
      request,
      state,
      context,
    });
  } finally {
    state.inpaintingEngineLease?.release();
    context.jobs.clearIfCurrent(id);
  }
}

export async function exportInpaintingResults(
  context: InpaintingJobContext,
  request: InpaintingExportRequest,
): Promise<InpaintingExportResult> {
  assertNoActiveJob(context);

  const id = randomUUID();
  const abortController = new AbortController();
  context.jobs.start({ id, kind: "inpainting", abortController });
  const emit = (event: JobEvent) =>
    emitJobEvent(context.jobs, context.getMainWindow(), event);

  try {
    return await runInpaintingExportJob({
      context,
      request,
      id,
      abortController,
      emit,
    });
  } catch (error) {
    return handleInpaintingExportError({
      abortController,
      emit,
      error,
      id,
      request,
    });
  } finally {
    context.jobs.clearIfCurrent(id);
  }
}

function assertNoActiveJob(context: Pick<InpaintingJobContext, "jobs">): void {
  if (context.jobs.hasActive) {
    throw new Error(tMain("jobs.active"));
  }
}
