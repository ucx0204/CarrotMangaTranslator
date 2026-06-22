import { randomUUID } from "node:crypto";
import type {
  RegionAnalysisRequest,
  RegionAnalysisResult,
  StartAnalysisRequest,
  StartAnalysisResult,
} from "../../shared/analysisTypes";
import type { JobEvent } from "../../shared/jobTypes";
import { resolvePagesForRun } from "../library";
import { emitJobEvent } from "./jobEvents";
import {
  type AnalysisJobState,
  handleAnalysisJobError,
  runResolvedAnalysisJob,
} from "./translationJobRunners";
import {
  type RegionJobState,
  handleRegionJobError,
  runRegionTranslationJob,
} from "./translationRegionJobRunner";
import type { TranslationJobContext } from "./translationJobTypes";

export type { TranslationJobContext } from "./translationJobTypes";

export async function startAnalysisJob(
  context: TranslationJobContext,
  request: StartAnalysisRequest,
): Promise<StartAnalysisResult> {
  if (context.jobs.hasActive) {
    return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
  }

  const id = randomUUID();
  const abortController = new AbortController();
  const state: AnalysisJobState = {
    resolved: null,
    pageIds: [],
    runPaths: null,
  };
  context.jobs.start({ id, kind: "gemma-analysis", abortController });
  const emit = (event: JobEvent) =>
    emitJobEvent(context.jobs, context.getMainWindow(), event);

  try {
    const requestedPageId =
      request.runMode === "single-page" ? request.pageId : undefined;
    state.resolved = await resolvePagesForRun(
      request.chapterId,
      request.runMode,
      requestedPageId,
    );
    if (state.resolved.pages.length === 0) {
      emit({
        id,
        kind: "gemma-analysis",
        status: "completed",
        progressText: "번역할 페이지가 없습니다.",
        phase: "done",
        progressCurrent: 0,
        progressTotal: 0,
        pageTotal: 0,
      });
      return {
        status: "completed",
        chapter: state.resolved.chapter,
        warnings: [],
      };
    }
    return await runResolvedAnalysisJob({
      context,
      request,
      id,
      abortController,
      emit,
      resolved: state.resolved,
      state,
    });
  } catch (error) {
    return handleAnalysisJobError({
      abortController,
      emit,
      error,
      id,
      request,
      state,
      context,
    });
  } finally {
    const job = context.jobs.current;
    if (job?.id === id) {
      await context.jobs.runCleanup(job, "job-finished");
      context.jobs.clearIfCurrent(id);
    }
  }
}

export async function translateRegionJob(
  context: TranslationJobContext,
  request: RegionAnalysisRequest,
): Promise<RegionAnalysisResult> {
  if (context.jobs.hasActive) {
    return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
  }

  const id = randomUUID();
  const abortController = new AbortController();
  const state: RegionJobState = { chapter: null, runPaths: null };
  context.jobs.start({ id, kind: "gemma-analysis", abortController });
  const emit = (event: JobEvent) =>
    emitJobEvent(context.jobs, context.getMainWindow(), event);

  try {
    return await runRegionTranslationJob({
      context,
      request,
      id,
      abortController,
      emit,
      state,
    });
  } catch (error) {
    return handleRegionJobError({
      abortController,
      emit,
      error,
      id,
      request,
      state,
      context,
    });
  } finally {
    const job = context.jobs.current;
    if (job?.id === id) {
      await context.jobs.runCleanup(job, "region-job-finished");
      context.jobs.clearIfCurrent(id);
    }
  }
}
