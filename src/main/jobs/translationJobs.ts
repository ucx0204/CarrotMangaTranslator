import { randomUUID } from "node:crypto";
import type {
  RegionAnalysisRequest,
  RegionAnalysisResult,
  StartAnalysisRequest,
  StartAnalysisResult,
} from "../../shared/analysisTypes";
import type { JobEvent } from "../../shared/jobTypes";
import { resolvePagesForRun } from "../library";
import { tMain } from "./localization";
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

type AnalysisJobRuntime = {
  resolvePagesForRun: typeof resolvePagesForRun;
  runResolvedAnalysisJob: typeof runResolvedAnalysisJob;
  handleAnalysisJobError: typeof handleAnalysisJobError;
};

type RegionJobRuntime = {
  runRegionTranslationJob: typeof runRegionTranslationJob;
  handleRegionJobError: typeof handleRegionJobError;
};

const productionAnalysisJobRuntime: AnalysisJobRuntime = {
  resolvePagesForRun,
  runResolvedAnalysisJob,
  handleAnalysisJobError,
};

const productionRegionJobRuntime: RegionJobRuntime = {
  runRegionTranslationJob,
  handleRegionJobError,
};

export async function startAnalysisJob(
  context: TranslationJobContext,
  request: StartAnalysisRequest,
  runtime: AnalysisJobRuntime = productionAnalysisJobRuntime,
): Promise<StartAnalysisResult> {
  if (context.jobs.hasActive) {
    return { status: "failed", error: tMain("jobs.active") };
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
    const requestedPageIds =
      request.runMode === "page-set" ? request.pageIds : undefined;
    state.resolved = await runtime.resolvePagesForRun(
      request.chapterId,
      request.runMode,
      requestedPageId,
      requestedPageIds,
    );
    if (state.resolved.pages.length === 0) {
      emit({
        id,
        kind: "gemma-analysis",
        status: "completed",
        progressText: tMain("translation.noPages"),
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
    return await runtime.runResolvedAnalysisJob({
      context,
      request,
      id,
      abortController,
      emit,
      resolved: state.resolved,
      state,
    });
  } catch (error) {
    return await runtime.handleAnalysisJobError({
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
  runtime: RegionJobRuntime = productionRegionJobRuntime,
): Promise<RegionAnalysisResult> {
  if (context.jobs.hasActive) {
    return { status: "failed", error: tMain("jobs.active") };
  }

  const id = randomUUID();
  const abortController = new AbortController();
  const state: RegionJobState = { chapter: null, runPaths: null };
  context.jobs.start({ id, kind: "gemma-analysis", abortController });
  const emit = (event: JobEvent) =>
    emitJobEvent(context.jobs, context.getMainWindow(), event);

  try {
    return await runtime.runRegionTranslationJob({
      context,
      request,
      id,
      abortController,
      emit,
      state,
    });
  } catch (error) {
    return await runtime.handleRegionJobError({
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
