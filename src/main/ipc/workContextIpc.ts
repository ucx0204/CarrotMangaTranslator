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
import { trustedHandleContract } from "./trustedIpc";

export function registerWorkContextIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    workContextIpcContracts.getWorkStyleGuide,
    async (_event, workId: unknown) => {
      const request = parseIpcPayload(
        WorkStyleGuideRequestSchema,
        { workId },
        "작품 용어집 열기",
      );
      return getWorkStyleGuide(request.workId);
    },
  );
  trustedHandleContract(
    context,
    workContextIpcContracts.saveWorkStyleGuide,
    async (_event, raw: unknown) =>
      saveWorkStyleGuide(
        parseIpcPayload(WorkStyleGuideSchema, raw, "작품 용어집 저장"),
      ),
  );
  trustedHandleContract(
    context,
    workContextIpcContracts.getChapterStoryMemory,
    async (_event, chapterId: unknown) => {
      const request = parseIpcPayload(
        ChapterStoryMemoryRequestSchema,
        { chapterId },
        "스토리 메모리 열기",
      );
      return getChapterStoryMemory(request.chapterId);
    },
  );
  trustedHandleContract(
    context,
    workContextIpcContracts.saveChapterStoryMemory,
    async (_event, raw: unknown) =>
      saveChapterStoryMemory(
        parseIpcPayload(ChapterStoryMemorySchema, raw, "스토리 메모리 저장"),
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
          "AI 용어/기억 분석",
        ),
      ),
  );
}
