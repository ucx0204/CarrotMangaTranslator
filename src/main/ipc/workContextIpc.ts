import { randomUUID } from "node:crypto";
import {
  AnalyzeWorkContextRequestSchema,
  ChapterStoryMemoryRequestSchema,
  ChapterStoryMemorySchema,
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
import { analyzeWorkContextWithAi } from "../workContextAnalysis";
import { buildWorkContextUsage } from "../workContextUsage";
import { emitJobEvent } from "../jobs/jobEvents";
import {
  getChapterStoryMemory,
  getWorkStyleGuide,
  resetWorkContext,
  saveChapterStoryMemory,
  saveWorkStyleGuide,
} from "../library";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";

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
  const operationGate = createWorkContextOperationGate(context);
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
    async (_event, raw: unknown) =>
      saveWorkStyleGuide(
        parseIpcPayload(
          WorkStyleGuideSchema,
          raw,
          tMain("ipc.labels.styleGuideSave"),
        ),
      ),
  );
  registerResetWorkContextIpc(context, operationGate);
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
    async (_event, raw: unknown) =>
      saveChapterStoryMemory(
        parseIpcPayload(
          ChapterStoryMemorySchema,
          raw,
          tMain("ipc.labels.storyMemorySave"),
        ),
      ),
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
      return buildWorkContextUsage(request.workId);
    },
  );
  trustedHandleContract(
    context,
    workContextIpcContracts.analyzeWorkContext,
    async (_event, raw: unknown) =>
      operationGate.run(() =>
        runWorkContextAnalysisJob(
          context,
          parseIpcPayload(
            AnalyzeWorkContextRequestSchema,
            raw,
            tMain("ipc.labels.workContextAnalysis"),
          ),
        ),
      ),
  );
}

type WorkContextJobContext = Pick<IpcContext, "getMainWindow" | "jobs">;
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
    const job = context.jobs.current;
    if (job?.id === id) {
      await context.jobs.runCleanup(job, "work-context-finished");
      context.jobs.clearIfCurrent(id);
    }
  }
}

function createWorkContextOperationGate(
  context: IpcContext,
): WorkContextOperationGate {
  return new WorkContextOperationGate({
    createBusyError: () => new Error(tMain("jobs.active")),
    isJobActive: () => context.jobs.hasActive,
  });
}

function registerResetWorkContextIpc(
  context: IpcContext,
  operationGate: WorkContextOperationGate,
): void {
  trustedHandleContract(
    context,
    workContextIpcContracts.resetWorkContext,
    async (_event, raw: unknown) =>
      operationGate.run(async () => {
        const request = parseIpcPayload(
          ChapterStoryMemoryRequestSchema,
          raw,
          tMain("ipc.labels.storyMemorySave"),
        );
        return resetWorkContext(request.chapterId);
      }),
  );
}
