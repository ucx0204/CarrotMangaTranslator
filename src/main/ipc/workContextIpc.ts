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
import {
  getChapterStoryMemory,
  getWorkStyleGuide,
  saveChapterStoryMemory,
  saveWorkStyleGuide,
} from "../library";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";

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
    workContextIpcContracts.analyzeWorkContext,
    async (_event, raw: unknown) =>
      analyzeWorkContextWithAi(
        parseIpcPayload(
          AnalyzeWorkContextRequestSchema,
          raw,
          tMain("ipc.labels.workContextAnalysis"),
        ),
      ),
  );
}
