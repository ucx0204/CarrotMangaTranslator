import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { makeChapter, makeOptions } from "./translationWorkflowFixtures";
// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { NotificationPort } from "../src/renderer/src/lib/notificationPort";

const startAnalysis = vi.fn();
const startInpainting = vi.fn();
const startSoundEffectTranslation = vi.fn();
const openChapter = vi.fn();
const finishPageTimingSession = vi.fn(async () => ({ updated: true }));
const notificationMocks: NotificationPort = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
};

beforeEach(() => {
  startAnalysis.mockReset();
  startInpainting.mockReset();
  openChapter.mockReset();
  window.mangaApi = createTestMangaGatewayStub({
    finishPageTimingSession,
    openChapter,
    startAnalysis,
    startInpainting,
    startSoundEffectTranslation,
  });
});

import { useTranslationActions } from "../src/renderer/src/hooks/useTranslationActions";

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  vi.clearAllMocks();
});

describe("translation failure propagation", () => {
  it.each(["all", "page-set", "empty", "inpainting-failure", "cancelled"])(
    "limits postprocessing to persisted successes and preserves stop rules: %s",
    async (scenario) => {
      const options = makeOptions();
      const page = makeChapter().pages[0];
      const bubbleLayout = scenario !== "page-set";
      const good = {
        ...page,
        id: "good",
        analysisStatus: "completed" as const,
        translationCompletion: {
          workflow: bubbleLayout
            ? ("bubble-layout" as const)
            : ("erase-original" as const),
          status: "pending" as const,
        },
      };
      const chapter: ChapterSnapshot = {
        ...makeChapter(),
        pages: [
          {
            ...page,
            analysisStatus: "failed",
            lastError: "checkpoint validation",
          },
          {
            ...good,
            analysisStatus: scenario === "empty" ? "failed" : "completed",
          },
          { ...good, id: "outside-selection" },
          { ...good, id: "unready", analysisStatus: "idle" },
          {
            ...good,
            id: "wrong-workflow",
            translationCompletion: {
              workflow: bubbleLayout ? "erase-original" : "bubble-layout",
              status: "pending",
            },
          },
        ],
      };
      openChapter.mockImplementation(async (id: string) => ({
        ...chapter,
        id,
      }));
      startAnalysis
        .mockResolvedValueOnce({
          status: "failed",
          failureScope: "page",
          error: "page failed",
        })
        .mockResolvedValueOnce({ status: "completed" });
      startInpainting.mockImplementation(async (request) => {
        if (scenario === "inpainting-failure")
          return { status: "failed", error: "disk write failed" };
        if (scenario === "cancelled") return { status: "cancelled" };
        return {
          status: "completed",
          chapters: [{ ...chapter, id: request.selections[0].chapterId }],
          pagesChanged: 1,
          blocksErased: 1,
        };
      });
      const { result } = renderHook(() =>
        useTranslationActions(options, notificationMocks),
      );
      await act(async () => {
        expect(
          await result.current.runTranslationFlow({
            selection: [
              scenario === "all"
                ? { chapterId: "chapter-1", mode: "all" }
                : {
                    chapterId: "chapter-1",
                    mode: "page-set",
                    pageIds: [page.id, "good", "unready", "wrong-workflow"],
                    restartPageIds: [],
                  },
              { chapterId: "chapter-2", mode: "all" },
            ],
            workflowMode: "cumulative",
            blockMode: "auto",
            eraseOriginalWorkflow: true,
            bubbleLayoutWorkflow: bubbleLayout,
          }),
        ).toBe(scenario === "cancelled" ? "cancelled" : "failed");
      });
      const halted =
        scenario === "inpainting-failure" || scenario === "cancelled";
      expect(startAnalysis).toHaveBeenCalledTimes(halted ? 1 : 2);
      const firstSelection = startInpainting.mock.calls[0][0].selections[0];
      expect(firstSelection).toEqual(
        scenario === "empty"
          ? { chapterId: "chapter-2", mode: "all" }
          : {
              chapterId: "chapter-1",
              mode: "page-set",
              pageIds:
                scenario === "all" ? ["good", "outside-selection"] : ["good"],
            },
      );
      expect(notificationMocks.success).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "continues queued chapters after persisted page failures (all failed=%s)",
    async (allFailed) => {
      const options = makeOptions();
      const failed: ChapterSnapshot = {
        ...makeChapter(),
        pages: makeChapter().pages.map((page) => ({
          ...page,
          analysisStatus: "failed" as const,
          lastError: "checkpoint validation",
        })),
      };
      if (!allFailed)
        failed.pages.push({
          ...failed.pages[0],
          id: "completed-page",
          analysisStatus: "completed" as const,
        });
      openChapter.mockImplementation(async (id: string) => ({
        ...makeChapter(),
        id,
      }));
      startAnalysis
        .mockResolvedValueOnce({
          status: "failed",
          failureScope: "page",
          chapter: failed,
          error: "1 page failed",
        })
        .mockResolvedValueOnce({ status: "completed" })
        .mockResolvedValueOnce({ status: "completed" });
      const { result } = renderHook(() =>
        useTranslationActions(options, notificationMocks),
      );
      await act(async () => {
        expect(
          await result.current.runTranslationFlow({
            selection: ["chapter-1", "chapter-2", "chapter-3"].map(
              (chapterId) => ({ chapterId, mode: "all" as const }),
            ),
            workflowMode: "cumulative",
            blockMode: "auto",
          }),
        ).toBe("failed");
      });
      expect(
        startAnalysis.mock.calls.map(([request]) => request.chapterId),
      ).toEqual(["chapter-1", "chapter-2", "chapter-3"]);
      expect(notificationMocks.success).not.toHaveBeenCalled();
      expect(options.setJobState).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
      expect(finishPageTimingSession).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["result", "exception"])(
    "retains the actual translation failure before inpainting starts (%s)",
    async (kind) => {
      const options = makeOptions();
      const message = "자동 폰트 맞춤 실패: source evidence unavailable";
      openChapter.mockResolvedValue(makeChapter());
      if (kind === "result")
        startAnalysis.mockResolvedValue({ status: "failed", error: message });
      else startAnalysis.mockRejectedValue(new Error(message));
      const { result } = renderHook(() =>
        useTranslationActions(options, notificationMocks),
      );
      await act(async () => {
        expect(
          await result.current.runTranslationFlow({
            selection: [{ chapterId: "chapter-1", mode: "pending" }],
            workflowMode: "cumulative",
            blockMode: "auto",
            eraseOriginalWorkflow: true,
            bubbleLayoutWorkflow: true,
          }),
        ).toBe("failed");
      });
      expect(startInpainting).not.toHaveBeenCalled();
      expect(notificationMocks.error).toHaveBeenCalledWith(message);
      expect(options.setJobState).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "failed", detail: message }),
      );
    },
  );
});
