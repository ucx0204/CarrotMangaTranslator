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

let workContextOperationActive = false;

export function registerWorkContextIpc(context: IpcContext): void {
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
      runExclusiveWorkContextOperation(context, () =>
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

function registerResetWorkContextIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    workContextIpcContracts.resetWorkContext,
    async (_event, raw: unknown) =>
      runExclusiveWorkContextOperation(context, async () => {
        const request = parseIpcPayload(
          ChapterStoryMemoryRequestSchema,
          raw,
          tMain("ipc.labels.storyMemorySave"),
        );
        return resetWorkContext(request.chapterId);
      }),
  );
}

async function runExclusiveWorkContextOperation<T>(
  context: IpcContext,
  operation: () => Promise<T>,
): Promise<T> {
  if (context.jobs.hasActive || workContextOperationActive) {
    throw new Error(tMain("jobs.active"));
  }
  workContextOperationActive = true;
  try {
    return await operation();
  } finally {
    workContextOperationActive = false;
  }
}
