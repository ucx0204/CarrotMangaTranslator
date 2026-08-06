import { randomUUID } from "node:crypto";
import type {
  RegionAnalysisRequest,
  RegionAnalysisResult,
  StartAnalysisRequest,
  StartAnalysisResult,
} from "../../shared/analysisTypes";
import type { JobEvent } from "../../shared/jobTypes";
import { MAX_ID_LIST_LENGTH } from "../../shared/ipcSchemaPrimitives";
import { resolvePagesForRun } from "../library";
import { throwIfAborted } from "../pipeline/failure";
import { tMain } from "./localization";
import { emitJobEvent } from "./jobEvents";
import { createJobLifetimeCleanupBoundary } from "./jobLifetimeCleanup";
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

// eslint-disable-next-line max-lines-per-function -- lifetime registration and terminal/finally ordering stay co-located for auditability
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
  const lifetime = createJobLifetimeCleanupBoundary();
  context.jobs.start({
    id,
    kind: "gemma-analysis",
    abortController,
    cleanup: lifetime.cleanup,
  });
  const emit = (event: JobEvent) =>
    emitJobEvent(context.jobs, context.getMainWindow(), event);

  try {
    const requestedPageId =
      request.runMode === "single-page" ? request.pageId : undefined;
    const requestedPageIds =
      request.runMode === "page-set" ? request.pageIds : undefined;
    assertValidRequestedPageIds(request);
    throwIfAborted(abortController.signal);
    state.resolved = await runtime.resolvePagesForRun(
      request.chapterId,
      request.runMode,
      requestedPageId,
      requestedPageIds,
    );
    throwIfAborted(abortController.signal);
    assertResolvedRequestedPages(request, state.resolved);
    if (state.resolved.pages.length === 0) {
      throwIfAborted(abortController.signal);
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
      registerResourceCleanup: lifetime.registerResourceCleanup,
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
    try {
      context.jobs.clearIfCurrent(id);
    } finally {
      lifetime.finish();
    }
  }
}

function assertValidRequestedPageIds(request: StartAnalysisRequest): void {
  if (request.runMode !== "page-set") {
    return;
  }
  if (request.pageIds.length === 0) {
    throw new Error("번역 페이지를 하나 이상 선택해야 합니다.");
  }
  if (request.pageIds.length > MAX_ID_LIST_LENGTH) {
    throw new Error(
      `번역 페이지는 한 번에 최대 ${MAX_ID_LIST_LENGTH}개까지 선택할 수 있습니다.`,
    );
  }
  if (new Set(request.pageIds).size !== request.pageIds.length) {
    throw new Error("번역 페이지 선택에 중복된 페이지 ID가 있습니다.");
  }
}

function assertResolvedRequestedPages(
  request: StartAnalysisRequest,
  resolved: Awaited<ReturnType<typeof resolvePagesForRun>>,
): void {
  if (request.runMode !== "single-page" && request.runMode !== "page-set") {
    return;
  }

  const requestedIds =
    request.runMode === "single-page" ? [request.pageId] : request.pageIds;
  const requestedIdSet = new Set(requestedIds);
  const resolvedIds = resolved.pages.map((page) => page.id);
  const resolvedIdSet = new Set(resolvedIds);
  const chapterIds = resolved.chapter.pages.map((page) => page.id);
  const chapterIdSet = new Set(chapterIds);
  const selectionMatches =
    resolved.chapter.id === request.chapterId &&
    requestedIdSet.size === requestedIds.length &&
    resolvedIdSet.size === resolvedIds.length &&
    chapterIdSet.size === chapterIds.length &&
    requestedIds.every((pageId) => chapterIdSet.has(pageId)) &&
    requestedIds.length === resolvedIds.length &&
    requestedIds.every((pageId) => resolvedIdSet.has(pageId));

  if (!selectionMatches) {
    throw new Error(
      "선택한 번역 페이지가 현재 화의 저장 상태와 일치하지 않습니다. 화를 새로고침한 뒤 다시 시도하세요.",
    );
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
  const lifetime = createJobLifetimeCleanupBoundary();
  context.jobs.start({
    id,
    kind: "gemma-analysis",
    abortController,
    cleanup: lifetime.cleanup,
  });
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
      registerResourceCleanup: lifetime.registerResourceCleanup,
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
    try {
      context.jobs.clearIfCurrent(id);
    } finally {
      lifetime.finish();
    }
  }
}
