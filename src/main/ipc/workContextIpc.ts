import { randomUUID } from "node:crypto";
import {
  ChapterStoryMemoryRequestSchema,
  ChapterStoryMemorySchema,
  ResearchWorkContextRequestSchema,
  SaveWorkResearchTitleRequestSchema,
  WorkStyleGuideRequestSchema,
  WorkStyleGuideSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { workContextIpcContracts } from "../../shared/ipcContracts";
import type { JobEvent } from "../../shared/jobTypes";
import {
  WORK_CONTEXT_ANALYSIS_CANCELLED_ERROR,
  type AnalyzeWorkContextRequest,
  type AnalyzeWorkContextResult,
} from "../../shared/workContextAnalysisTypes";
import {
  WORK_CONTEXT_RESEARCH_CANCELLED_ERROR,
  type ResearchWorkContextRequest,
  type WorkContextResearchProposal,
} from "../../shared/workContextResearchTypes";
import { analyzeWorkContextWithAi } from "../workContextAnalysis";
import {
  researchWorkContext,
  type WorkContextResearchProgressHandler,
} from "../workContextResearch";
import {
  buildWorkContextUsage,
  type WorkContextUsageRepository,
} from "../workContextUsage";
import { emitJobEvent } from "../jobs/jobEvents";
import {
  getChapterStoryMemory,
  getWorkResearchTitle,
  getWorkStyleGuide,
  listLibrary,
  openChapter,
  resetWorkContext,
  saveChapterStoryMemory,
  saveWorkResearchTitle,
  saveWorkStyleGuide,
} from "../library";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";
import { getAppSettings } from "../settingsStore";
import type { AppSettings } from "../../shared/settingsTypes";
import type { AppActivityResource } from "../../shared/appActivityTypes";
import { createJobLifetimeCleanupBoundary } from "../jobs/jobLifetimeCleanup";

const workContextUsageRepository: WorkContextUsageRepository = {
  getChapterStoryMemory,
  getWorkStyleGuide,
  listLibrary,
  openChapter,
};

export interface WorkContextOperationGateDependencies {
  createBusyError: () => Error;
  isJobActive: () => boolean;
}

export class WorkContextOperationGate {
  private active = false;

  constructor(
    private readonly dependencies: WorkContextOperationGateDependencies,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.dependencies.isJobActive() || this.active) {
      throw this.dependencies.createBusyError();
    }
    this.active = true;
    try {
      return await operation();
    } finally {
      this.active = false;
    }
  }
}

export function registerWorkContextIpc(context: IpcContext): void {
  registerWorkResearchTitleIpc(context);
  trustedHandleContract(
    context,
    workContextIpcContracts.getWorkStyleGuide,
    async (_event, workId: unknown) => {
      const request = parseIpcPayload(
        WorkStyleGuideRequestSchema,
        { workId },
        tMain("ipc.labels.styleGuideOpen"),
      );
      return getWorkStyleGuide(request.workId);
    },
  );
  trustedHandleContract(
    context,
    workContextIpcContracts.saveWorkStyleGuide,
    async (_event, raw: unknown) => {
      const guide = parseIpcPayload(
        WorkStyleGuideSchema,
        raw,
        tMain("ipc.labels.styleGuideSave"),
      );
      return saveWorkStyleGuide(guide, guide.updatedAt);
    },
  );
  registerResetWorkContextIpc(context);
  trustedHandleContract(
    context,
    workContextIpcContracts.getChapterStoryMemory,
    async (_event, chapterId: unknown) => {
      const request = parseIpcPayload(
        ChapterStoryMemoryRequestSchema,
        { chapterId },
        tMain("ipc.labels.storyMemoryOpen"),
      );
      return getChapterStoryMemory(request.chapterId);
    },
  );
  trustedHandleContract(
    context,
    workContextIpcContracts.saveChapterStoryMemory,
    async (_event, raw: unknown) => {
      const memory = parseIpcPayload(
        ChapterStoryMemorySchema,
        raw,
        tMain("ipc.labels.storyMemorySave"),
      );
      return saveChapterStoryMemory(memory, memory.updatedAt);
    },
  );
  trustedHandleContract(
    context,
    workContextIpcContracts.getWorkContextUsage,
    async (_event, workId: unknown) => {
      const request = parseIpcPayload(
        WorkStyleGuideRequestSchema,
        { workId },
        tMain("ipc.labels.styleGuideOpen"),
      );
      return buildWorkContextUsage(request.workId, workContextUsageRepository);
    },
  );
  registerInternetResearchIpc(context);
}

function registerWorkResearchTitleIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    workContextIpcContracts.getWorkResearchTitle,
    async (_event, workId: unknown) => {
      const request = parseIpcPayload(
        WorkStyleGuideRequestSchema,
        { workId },
        "작품 조사 제목 열기",
      );
      return getWorkResearchTitle(request.workId);
    },
  );
  trustedHandleContract(
    context,
    workContextIpcContracts.saveWorkResearchTitle,
    async (_event, raw: unknown) =>
      saveWorkResearchTitle(
        parseIpcPayload(
          SaveWorkResearchTitleRequestSchema,
          raw,
          "작품 조사 제목 저장",
        ),
      ),
  );
}

function registerInternetResearchIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    workContextIpcContracts.researchWorkContext,
    async (_event, raw: unknown) =>
      runWorkContextResearchJob(
        {
          ...context,
          executionSettings: await getAppSettings(context.appPaths),
        },
        parseIpcPayload(ResearchWorkContextRequestSchema, raw, "인터넷 조사"),
      ),
  );
  trustedHandleContract(
    context,
    workContextIpcContracts.cancelWorkContextResearch,
    async (_event, runId) => {
      const job = context.jobs.get(researchJobId(runId));
      if (!job || job.id !== researchJobId(runId)) {
        return { cancelled: false };
      }
      job.abortController.abort();
      return { cancelled: true };
    },
  );
}

type WorkContextJobContext = Pick<IpcContext, "getMainWindow" | "jobs"> & {
  executionSettings?: AppSettings;
};
type WorkContextAnalyzer = (
  request: AnalyzeWorkContextRequest,
  signal: AbortSignal,
) => Promise<AnalyzeWorkContextResult>;

/**
 * Owns the AI context request as a real cancellable job so the common cancel
 * IPC can abort the model fetch, including the gap between translation passes.
 */
export async function runWorkContextAnalysisJob(
  context: WorkContextJobContext,
  request: AnalyzeWorkContextRequest,
  analyze: WorkContextAnalyzer = analyzeWorkContextWithAi,
): Promise<AnalyzeWorkContextResult> {
  if (context.jobs.hasActive) {
    throw new Error(tMain("jobs.active"));
  }
  const id = `work-context-${randomUUID()}`;
  const abortController = new AbortController();
  context.jobs.start({ id, kind: "gemma-analysis", abortController });
  const emit = (event: JobEvent): void =>
    emitJobEvent(context.jobs, context.getMainWindow(), event);
  emit({
    id,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain("ipc.labels.workContextAnalysis"),
    phase: "model_requesting",
    progressMode: "indeterminate",
  });
  try {
    const result = await analyze(request, abortController.signal);
    abortController.signal.throwIfAborted();
    emit({
      id,
      kind: "gemma-analysis",
      status: "completed",
      progressText: tMain("ipc.labels.workContextAnalysis"),
      phase: "done",
    });
    return result;
  } catch (error) {
    if (abortController.signal.aborted) {
      emit({
        id,
        kind: "gemma-analysis",
        status: "cancelled",
        progressText: tMain("jobs.cancelled"),
        phase: "cancelled",
      });
      throw new Error(WORK_CONTEXT_ANALYSIS_CANCELLED_ERROR, { cause: error });
    }
    const detail = error instanceof Error ? error.message : String(error);
    emit({
      id,
      kind: "gemma-analysis",
      status: "failed",
      progressText: tMain("jobs.failed"),
      phase: "failed",
      detail,
    });
    throw error;
  } finally {
    const job = context.jobs.get(id);
    if (job?.id === id) {
      await context.jobs.runCleanup(job, "work-context-finished");
      context.jobs.clearIfCurrent(id);
    }
  }
}

type WorkContextResearcher = (
  request: ResearchWorkContextRequest,
  signal: AbortSignal,
  onProgress?: WorkContextResearchProgressHandler,
) => Promise<WorkContextResearchProposal>;

export async function runWorkContextResearchJob(
  context: WorkContextJobContext,
  request: ResearchWorkContextRequest,
  research: WorkContextResearcher = researchWorkContext,
): Promise<WorkContextResearchProposal> {
  const id = researchJobId(request.runId);
  const abortController = new AbortController();
  const lifetime = createJobLifetimeCleanupBoundary();
  const resources = researchActivityResources(context, request);
  context.jobs.start({
    id,
    kind: "internet-research",
    resources,
    abortController,
    cleanup: lifetime.cleanup,
  });
  const emit = (event: JobEvent): void =>
    emitJobEvent(context.jobs, context.getMainWindow(), event);
  emit({
    id,
    kind: "internet-research",
    status: "running",
    progressText: "조사 준비 중",
    phase: "booting",
    progressMode: "indeterminate",
    research: { stage: "preparing" },
  });
  try {
    const result = await context.jobs.run(
      id,
      () =>
        research(request, abortController.signal, (progress) =>
          emit({
            id,
            kind: "internet-research",
            status: "running",
            ...progress,
            pageIndex: progress.pageIndex ?? undefined,
            pageTotal: progress.pageTotal ?? undefined,
          }),
        ),
      context.executionSettings,
    );
    abortController.signal.throwIfAborted();
    emit({
      id,
      kind: "internet-research",
      status: "completed",
      progressText: "인터넷 조사 완료",
      phase: "done",
      research: { stage: "finalizing" },
    });
    return result;
  } catch (error) {
    if (abortController.signal.aborted) {
      emit({
        id,
        kind: "internet-research",
        status: "cancelled",
        progressText: tMain("jobs.cancelled"),
        phase: "cancelled",
      });
      throw new Error(WORK_CONTEXT_RESEARCH_CANCELLED_ERROR, { cause: error });
    }
    emit({
      id,
      kind: "internet-research",
      status: "failed",
      progressText: tMain("jobs.failed"),
      phase: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    context.jobs.clearIfCurrent(id);
    lifetime.finish();
  }
}

function researchActivityResources(
  context: WorkContextJobContext,
  request: ResearchWorkContextRequest,
): AppActivityResource[] {
  return request.engine === "codex-web"
    ? [{ kind: "codex-auth", scope: "*", access: "read" }]
    : context.executionSettings?.internetResearch.tavilyAnalysisProvider ===
        "api"
      ? []
      : [{ kind: "model-runtime", scope: "*", access: "write" }];
}

function researchJobId(runId: string): string {
  return `work-context-research-${runId}`;
}

function registerResetWorkContextIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    workContextIpcContracts.resetWorkContext,
    async (_event, raw: unknown) => {
      const request = parseIpcPayload(
        ChapterStoryMemoryRequestSchema,
        raw,
        tMain("ipc.labels.storyMemorySave"),
      );
      return resetWorkContext(request.chapterId);
    },
  );
}
