import {
  AnalyzeWorkContextRequestSchema,
  ChapterStoryMemoryRequestSchema,
  ChapterStoryMemorySchema,
  WorkStyleGuideRequestSchema,
  WorkStyleGuideSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { workContextIpcContracts } from "../../shared/ipcContracts";
import { analyzeWorkContextWithAi } from "../workContextAnalysis";
import { buildWorkContextUsage } from "../workContextUsage";
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
        analyzeWorkContextWithAi(
          parseIpcPayload(
            AnalyzeWorkContextRequestSchema,
            raw,
            tMain("ipc.labels.workContextAnalysis"),
          ),
        ),
      ),
  );
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
