import {
  AnalyzeWorkContextRequestSchema,
  ChapterStoryMemoryRequestSchema,
  ChapterStoryMemorySchema,
  WorkStyleGuideRequestSchema,
  WorkStyleGuideSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { analyzeWorkContextWithAi } from "../workContextAnalysis";
import {
  getChapterStoryMemory,
  getWorkStyleGuide,
  saveChapterStoryMemory,
  saveWorkStyleGuide,
} from "../library";
import type { IpcContext } from "./context";
import { trustedHandle } from "./trustedIpc";

export function registerWorkContextIpc(context: IpcContext): void {
  trustedHandle(
    context,
    "context:get-work-style-guide",
    async (_event, workId: unknown) => {
      const request = parseIpcPayload(
        WorkStyleGuideRequestSchema,
        { workId },
        "작품 용어집 열기",
      );
      return getWorkStyleGuide(request.workId);
    },
  );
  trustedHandle(
    context,
    "context:save-work-style-guide",
    async (_event, raw: unknown) =>
      saveWorkStyleGuide(
        parseIpcPayload(WorkStyleGuideSchema, raw, "작품 용어집 저장"),
      ),
  );
  trustedHandle(
    context,
    "context:get-chapter-story-memory",
    async (_event, chapterId: unknown) => {
      const request = parseIpcPayload(
        ChapterStoryMemoryRequestSchema,
        { chapterId },
        "스토리 메모리 열기",
      );
      return getChapterStoryMemory(request.chapterId);
    },
  );
  trustedHandle(
    context,
    "context:save-chapter-story-memory",
    async (_event, raw: unknown) =>
      saveChapterStoryMemory(
        parseIpcPayload(ChapterStoryMemorySchema, raw, "스토리 메모리 저장"),
      ),
  );
  trustedHandle(
    context,
    "context:analyze-work-context",
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
