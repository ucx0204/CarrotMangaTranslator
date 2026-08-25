// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { NotificationPort } from "../src/renderer/src/lib/notificationPort";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationWorkflowMode } from "../src/shared/settingsTypes";
import type { UseTranslationActionsOptions } from "../src/renderer/src/hooks/translationActionTypes";

const startAnalysis = vi.fn();
const startInpainting = vi.fn();
const openChapter = vi.fn();
const notificationMocks: NotificationPort = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
};

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    openChapter,
    startAnalysis,
    startInpainting,
  });
});

import { useTranslationActions } from "../src/renderer/src/hooks/useTranslationActions";

const TS = "2026-01-01T00:00:00.000Z";

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "C:/page.png",
    dataUrl: "",
    width: 100,
    height: 150,
    blocks: [],
    analysisStatus: "idle",
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeChapter(): ChapterSnapshot {
  const page = makePage();
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: [page.id],
    pages: [page],
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeOptions(): UseTranslationActionsOptions {
  const chapter = makeChapter();
  return {
    clearPageImageCache: vi.fn(),
    clearRetouchHistory: vi.fn(),
    clearStatusLines: vi.fn(),
    currentChapter: chapter,
    currentChapterRef: { current: chapter },
    jobActive: false,
    library: { workOrder: [], works: [] },
    mergeLiveChapter: vi.fn(),
    pushStatus: vi.fn(),
    refreshLibrary: vi.fn().mockResolvedValue(undefined),
    recordImageEdit: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    selectedPage: null,
    setCurrentChapter: vi.fn(),
    setFlowActive: vi.fn(),
    setShowBlockChrome: vi.fn(),
    setJobState: vi.fn(),
    setSelectedBlockId: vi.fn(),
    syncSavedPageVersion: vi.fn(),
  };
}

async function runWorkflow(workflowMode: TranslationWorkflowMode) {
  const options = makeOptions();
  startAnalysis.mockResolvedValue({ status: "completed" });
  const { result } = renderHook(() =>
    useTranslationActions(options, notificationMocks),
  );

  await act(async () => {
    await result.current.runTranslationFlow({
      selection: [{ chapterId: "chapter-1", mode: "pending" }],
      workflowMode,
      blockMode: "auto",
    });
  });

  return options;
}

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  vi.clearAllMocks();
});

describe("translation workflow modes", () => {
  it("records one recoverable checkpoint around a page retranslation", async () => {
    const options = makeOptions();
    const originalBlock = {
      id: "block-1",
      type: "nonsolid" as const,
      bbox: { x: 1, y: 2, w: 30, h: 20 },
      sourceText: "original",
      translatedText: "manual edit",
      confidence: 1,
      sourceDirection: "horizontal" as const,
      renderDirection: "horizontal" as const,
      fontSizePx: 16,
      lineHeight: 1.2,
      textAlign: "center" as const,
      textColor: "#000000",
      backgroundColor: "#ffffff",
      opacity: 1,
    };
    const before = {
      ...makeChapter(),
      pages: [{ ...makePage(), blocks: [originalBlock] }],
    };
    const beforePage = before.pages[0];
    if (!beforePage) throw new Error("test page is missing");
    const after = {
      ...before,
      pages: [
        {
          ...beforePage,
          blocks: [{ ...originalBlock, translatedText: "new translation" }],
          analysisStatus: "completed" as const,
        },
      ],
    };
    options.currentChapter = before;
    options.currentChapterRef.current = before;
    options.recordTranslationCheckpoint = vi.fn();
    options.mergeLiveChapter = vi.fn((chapter) => {
      options.currentChapterRef.current = chapter;
    });
    startAnalysis.mockResolvedValue({ status: "completed", chapter: after });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runAnalysis("single-page", "page-1");
    });

    expect(options.recordTranslationCheckpoint).toHaveBeenCalledWith({
      before,
      after,
      pageIds: ["page-1"],
      label: "재번역 전 체크포인트",
    });
  });

  it("snapshots pending pages, then translates, inpaints, and lays them out", async () => {
    const options = makeOptions();
    const pendingSnapshot = {
      ...makeChapter(),
      pageOrder: ["page-1", "page-done"],
      pages: [
        makePage(),
        {
          ...makePage(),
          id: "page-done",
          name: "done.png",
          analysisStatus: "completed" as const,
        },
      ],
    };
    const completedChapter = {
      ...makeChapter(),
      pages: [
        {
          ...makePage(),
          analysisStatus: "completed" as const,
          inpaintedImagePath: "C:/page-clean.png",
        },
      ],
    };
    openChapter.mockResolvedValue(pendingSnapshot);
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [completedChapter],
      pagesChanged: 1,
      blocksErased: 1,
      historyTransaction: { transactionId: "tx-translation-layout" },
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    let outcome = "not-started";
    await act(async () => {
      outcome = await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "pending" }],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(outcome).toBe("completed");
    expect(openChapter).toHaveBeenCalledWith("chapter-1");
    expect(startInpainting).toHaveBeenCalledWith({
      mode: "selection-pattern",
      workId: "work-1",
      selections: [
        {
          chapterId: "chapter-1",
          mode: "page-set",
          pageIds: ["page-1", "page-done"],
        },
      ],
      postprocess: {
        bubbleLayout: {
          enabled: true,
          policy: "balanced",
          naturalTextLayout: true,
        },
      },
    });
    expect(startAnalysis.mock.invocationCallOrder[0]).toBeLessThan(
      startInpainting.mock.invocationCallOrder[0] ?? 0,
    );
    expect(startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ completionWorkflow: "bubble-layout" }),
    );
    expect(options.mergeLiveChapter).toHaveBeenCalledWith(completedChapter);
    expect(options.clearRetouchHistory).toHaveBeenCalledOnce();
    expect(options.recordImageEdit).toHaveBeenCalledWith({
      label: "자동 지우기",
      transactionId: "tx-translation-layout",
      chapterId: "chapter-1",
    });
    expect(options.setShowBlockChrome).toHaveBeenCalledWith(false);
  });

  it("can erase translated source text without running bubble postprocess", async () => {
    const options = makeOptions();
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [makeChapter()],
      pagesChanged: 1,
      blocksErased: 1,
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "all" }],
        workflowMode: "cumulative",
        blockMode: "auto",
        naturalTextLayout: true,
        eraseOriginalWorkflow: true,
        bubbleLayoutWorkflow: false,
      });
    });

    expect(startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ naturalTextLayout: true }),
    );
    expect(startInpainting).toHaveBeenCalledWith({
      mode: "selection-pattern",
      workId: "work-1",
      selections: [{ chapterId: "chapter-1", mode: "all" }],
      postprocess: {
        bubbleLayout: { enabled: false, policy: "balanced" },
      },
    });
    expect(notificationMocks.success).toHaveBeenCalledWith(
      "번역·원문 지우기를 완료했습니다.",
    );
    expect(options.pushStatus).toHaveBeenCalledWith(
      expect.stringMatching(
        /^번역·원문 지우기를 완료했습니다\. · 전체 (?:1초 미만|\d)/,
      ),
    );
    expect(options.setJobState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "completed",
        phase: "done",
        jobElapsedMs: expect.any(Number),
      }),
    );
    expect(startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ completionWorkflow: "erase-original" }),
    );
  });

  it("does not erase when the new completion mode is explicitly translation only", async () => {
    const options = makeOptions();
    startAnalysis.mockResolvedValue({ status: "completed" });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "all" }],
        workflowMode: "cumulative",
        blockMode: "auto",
        eraseOriginalWorkflow: false,
        bubbleLayoutWorkflow: true,
      });
    });

    expect(startAnalysis).toHaveBeenCalledOnce();
    expect(startInpainting).not.toHaveBeenCalled();
  });

  it("does not erase or lay out pages when translation fails", async () => {
    const options = makeOptions();
    openChapter.mockResolvedValue(makeChapter());
    startAnalysis.mockResolvedValue({
      status: "failed",
      error: "translation failed",
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    let outcome = "not-started";
    await act(async () => {
      outcome = await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "pending" }],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(outcome).toBe("failed");
    expect(startInpainting).not.toHaveBeenCalled();
    expect(options.setShowBlockChrome).not.toHaveBeenCalled();
  });

  it("preserves token-limit guidance through the deferred translation flow", async () => {
    const options = makeOptions();
    startAnalysis.mockResolvedValue({
      status: "failed",
      error: "truncated response",
      failureGuidance: "increase-work-context-budget",
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    let outcome = "not-started";
    await act(async () => {
      outcome = await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "pending" }],
        workflowMode: "cumulative",
        blockMode: "auto",
      });
    });

    expect(outcome).toBe("failed");
    expect(options.setJobState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "failed",
        failureGuidance: "increase-work-context-budget",
        progressText: expect.stringContaining("작품 컨텍스트 예산"),
      }),
    );
    expect(notificationMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("설정 > 번역 엔진 > 작품 컨텍스트 예산"),
    );
  });

  it("stops the multi-chapter workflow when a chapter translation fails", async () => {
    const options = makeOptions();
    const calls: string[] = [];
    startAnalysis.mockImplementation(async (request) => {
      calls.push(`T:${request.chapterId}`);
      return request.chapterId === "chapter-2"
        ? { status: "failed", error: "chapter 2 failed" }
        : { status: "completed" };
    });
    startInpainting.mockImplementation(async (request) => {
      const selection = request.selections[0];
      calls.push(`I:${selection.chapterId}`);
      return {
        status: "completed",
        chapters: [{ ...makeChapter(), id: selection.chapterId }],
        pagesChanged: 1,
        blocksErased: 1,
      };
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    let outcome = "not-started";
    await act(async () => {
      outcome = await result.current.runTranslationFlow({
        selection: [
          { chapterId: "chapter-1", mode: "all" },
          { chapterId: "chapter-2", mode: "all" },
          { chapterId: "chapter-3", mode: "all" },
        ],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(outcome).toBe("failed");
    expect(startAnalysis).toHaveBeenCalledTimes(2);
    expect(startInpainting).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["T:chapter-1", "I:chapter-1", "T:chapter-2"]);
    expect(options.setJobState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("does not start the next chapter after inpainting fails", async () => {
    const options = makeOptions();
    const calls: string[] = [];
    startAnalysis.mockImplementation(async (request) => {
      calls.push(`T:${request.chapterId}`);
      return { status: "completed" };
    });
    startInpainting.mockImplementation(async (request) => {
      const selection = request.selections[0];
      calls.push(`I:${selection.chapterId}`);
      if (selection.chapterId === "chapter-1") {
        return { status: "failed", error: "inpaint failed" };
      }
      return {
        status: "completed",
        chapters: [{ ...makeChapter(), id: selection.chapterId }],
        pagesChanged: 1,
        blocksErased: 1,
      };
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    let outcome = "not-started";
    await act(async () => {
      outcome = await result.current.runTranslationFlow({
        selection: [
          { chapterId: "chapter-1", mode: "all" },
          { chapterId: "chapter-2", mode: "all" },
          { chapterId: "chapter-3", mode: "all" },
        ],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(outcome).toBe("failed");
    expect(calls).toEqual(["T:chapter-1", "I:chapter-1"]);
    expect(options.refreshLibrary).toHaveBeenCalled();
    expect(notificationMocks.success).not.toHaveBeenCalled();
  });

  it("persists a partial inpainting result and continues with the next chapter", async () => {
    const options = makeOptions();
    const calls: string[] = [];
    startAnalysis.mockImplementation(async (request) => {
      calls.push(`T:${request.chapterId}`);
      return { status: "completed" };
    });
    startInpainting.mockImplementation(async (request) => {
      const selection = request.selections[0];
      calls.push(`I:${selection.chapterId}`);
      return selection.chapterId === "chapter-1"
        ? {
            status: "partial",
            chapters: [{ ...makeChapter(), id: selection.chapterId }],
            pagesChanged: 1,
            blocksErased: 6,
            pagesIncomplete: 1,
            blocksIncomplete: 1,
          }
        : {
            status: "completed",
            chapters: [{ ...makeChapter(), id: selection.chapterId }],
            pagesChanged: 1,
            blocksErased: 1,
          };
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    let outcome = "not-started";
    await act(async () => {
      outcome = await result.current.runTranslationFlow({
        selection: [
          { chapterId: "chapter-1", mode: "all" },
          { chapterId: "chapter-2", mode: "all" },
        ],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(outcome).toBe("partial");
    expect(calls).toEqual([
      "T:chapter-1",
      "I:chapter-1",
      "T:chapter-2",
      "I:chapter-2",
    ]);
    expect(options.setJobState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "partial", phase: "partial" }),
    );
    expect(notificationMocks.warn).toHaveBeenCalledOnce();
    expect(notificationMocks.error).not.toHaveBeenCalled();
    expect(notificationMocks.success).not.toHaveBeenCalled();
  });

  it("stops the whole pipeline immediately when a chapter is cancelled", async () => {
    const options = makeOptions();
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({ status: "cancelled" });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    let outcome = "not-started";
    await act(async () => {
      outcome = await result.current.runTranslationFlow({
        selection: [
          { chapterId: "chapter-1", mode: "all" },
          { chapterId: "chapter-2", mode: "all" },
        ],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(outcome).toBe("cancelled");
    expect(startAnalysis).toHaveBeenCalledTimes(1);
    expect(startInpainting).toHaveBeenCalledTimes(1);
    expect(options.setJobState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("resumes a pending combined workflow whose translation already completed", async () => {
    const options = makeOptions();
    openChapter.mockResolvedValue({
      ...makeChapter(),
      pages: [
        {
          ...makePage(),
          analysisStatus: "completed",
          translationCompletion: {
            workflow: "bubble-layout",
            status: "pending",
          },
        },
      ],
    });
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [makeChapter()],
      pagesChanged: 1,
      blocksErased: 1,
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "pending" }],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(startInpainting).toHaveBeenCalledWith(
      expect.objectContaining({
        selections: [
          { chapterId: "chapter-1", mode: "page-set", pageIds: ["page-1"] },
        ],
      }),
    );
  });

  it("retranslates a pending page when its completed receipt is for another workflow", async () => {
    const options = makeOptions();
    openChapter.mockResolvedValue({
      ...makeChapter(),
      pages: [
        {
          ...makePage(),
          analysisStatus: "completed",
          translationCompletion: {
            workflow: "erase-original",
            status: "completed",
          },
        },
      ],
    });
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [makeChapter()],
      pagesChanged: 1,
      blocksErased: 1,
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "pending" }],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        runMode: "page-set",
        pageIds: ["page-1"],
        completionWorkflow: "bubble-layout",
      }),
    );
    expect(startInpainting).toHaveBeenCalledWith(
      expect.objectContaining({
        selections: [
          { chapterId: "chapter-1", mode: "page-set", pageIds: ["page-1"] },
        ],
      }),
    );
  });

  it("keeps partial Bubble workflow changes undoable when inpainting fails", async () => {
    const options = makeOptions();
    const partiallyUpdatedChapter = {
      ...makeChapter(),
      pages: [
        {
          ...makePage(),
          inpaintedImagePath: "C:/page-partial-clean.png",
        },
      ],
    };
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "failed",
      error: "postprocess failed",
      chapters: [partiallyUpdatedChapter],
      historyTransaction: { transactionId: "tx-partial-failed" },
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    let outcome = "not-started";
    await act(async () => {
      outcome = await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "all" }],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(outcome).toBe("failed");
    expect(options.clearPageImageCache).toHaveBeenCalledOnce();
    expect(options.clearRetouchHistory).toHaveBeenCalledOnce();
    expect(options.mergeLiveChapter).toHaveBeenCalledWith(
      partiallyUpdatedChapter,
    );
    expect(options.recordImageEdit).toHaveBeenCalledWith({
      label: "자동 지우기",
      transactionId: "tx-partial-failed",
      chapterId: "chapter-1",
    });
    expect(options.setShowBlockChrome).not.toHaveBeenCalled();
    expect(notificationMocks.success).not.toHaveBeenCalledWith(
      "번역·자동 지우기·말풍선 맞춤을 완료했습니다.",
    );
    expect(notificationMocks.error).toHaveBeenCalledWith("postprocess failed");
  });

  it("keeps partial Bubble workflow changes undoable when inpainting is cancelled", async () => {
    const options = makeOptions();
    const partiallyUpdatedChapter = {
      ...makeChapter(),
      pages: [
        {
          ...makePage(),
          inpaintedImagePath: "C:/page-partial-cancelled.png",
        },
      ],
    };
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "cancelled",
      chapters: [partiallyUpdatedChapter],
      historyTransaction: { transactionId: "tx-partial-cancelled" },
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    let outcome = "not-started";
    await act(async () => {
      outcome = await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "all" }],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(outcome).toBe("cancelled");
    expect(options.clearPageImageCache).toHaveBeenCalledOnce();
    expect(options.clearRetouchHistory).toHaveBeenCalledOnce();
    expect(options.mergeLiveChapter).toHaveBeenCalledWith(
      partiallyUpdatedChapter,
    );
    expect(options.recordImageEdit).toHaveBeenCalledWith({
      label: "자동 지우기",
      transactionId: "tx-partial-cancelled",
      chapterId: "chapter-1",
    });
    expect(options.setShowBlockChrome).not.toHaveBeenCalled();
    expect(notificationMocks.success).not.toHaveBeenCalledWith(
      "번역·자동 지우기·말풍선 맞춤을 완료했습니다.",
    );
  });

  it("rejects a completed Bubble response with no changed chapter", async () => {
    const options = makeOptions();
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [],
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    let outcome = "not-started";
    await act(async () => {
      outcome = await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "all" }],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(outcome).toBe("failed");
    expect(options.clearRetouchHistory).not.toHaveBeenCalled();
    expect(options.clearPageImageCache).not.toHaveBeenCalled();
    expect(options.mergeLiveChapter).not.toHaveBeenCalled();
    expect(options.setShowBlockChrome).not.toHaveBeenCalled();
    expect(options.setJobState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("uses cumulative collection for direct translation entry points by default", async () => {
    const options = makeOptions();
    startAnalysis.mockResolvedValue({ status: "completed" });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runAnalysis("pending");
    });

    expect(startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ collectPageContext: true }),
    );
  });

  it("respects a standard default for direct translation entry points", async () => {
    const options = {
      ...makeOptions(),
      translationWorkflowDefault: "standard" as const,
    };
    startAnalysis.mockResolvedValue({ status: "completed" });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runAnalysis("all");
    });

    expect(startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ collectPageContext: false }),
    );
  });

  it("defaults natural layout on for direct translation entry points", async () => {
    const options = makeOptions();
    startAnalysis.mockResolvedValue({ status: "completed" });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runAnalysis("pending");
    });

    expect(startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ naturalTextLayout: true }),
    );
  });

  it("preserves an explicitly saved natural layout off setting", async () => {
    const options = {
      ...makeOptions(),
      naturalTextLayoutDefault: false,
    };
    startAnalysis.mockResolvedValue({ status: "completed" });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runAnalysis("pending");
    });

    expect(startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ naturalTextLayout: false }),
    );
  });

  it("defers natural hard breaks until Bubble postprocess knows the final shape", async () => {
    const options = makeOptions();
    openChapter.mockResolvedValue(makeChapter());
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [makeChapter()],
      pagesChanged: 1,
      blocksErased: 1,
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "all" }],
        workflowMode: "cumulative",
        blockMode: "auto",
        autoFontMatching: true,
        naturalTextLayout: true,
        bubbleLayoutWorkflow: true,
      });
    });

    expect(startAnalysis).toHaveBeenCalledOnce();
    expect(startAnalysis.mock.calls[0]?.[0]).toMatchObject({
      autoFontMatching: true,
    });
    expect(startAnalysis.mock.calls[0]?.[0]).not.toHaveProperty(
      "naturalTextLayout",
    );
    expect(startInpainting).toHaveBeenCalledWith(
      expect.objectContaining({
        postprocess: {
          bubbleLayout: {
            enabled: true,
            policy: "balanced",
            naturalTextLayout: true,
          },
        },
      }),
    );
  });

  it("keeps natural hard breaks disabled during Bubble postprocess when requested", async () => {
    const options = makeOptions();
    openChapter.mockResolvedValue(makeChapter());
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [makeChapter()],
      pagesChanged: 1,
      blocksErased: 1,
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "all" }],
        workflowMode: "cumulative",
        blockMode: "auto",
        naturalTextLayout: false,
        bubbleLayoutWorkflow: true,
      });
    });

    expect(startAnalysis.mock.calls[0]?.[0]).not.toHaveProperty(
      "naturalTextLayout",
    );
    expect(startInpainting).toHaveBeenCalledWith(
      expect.objectContaining({
        postprocess: {
          bubbleLayout: { enabled: true, policy: "balanced" },
        },
      }),
    );
  });

  it("collects page context during the cumulative single pass", async () => {
    await runWorkflow("cumulative");

    expect(startAnalysis).toHaveBeenCalledOnce();
    expect(startAnalysis).toHaveBeenCalledWith({
      chapterId: "chapter-1",
      runMode: "pending",
      blockMode: "auto",
      collectPageContext: true,
    });
    expect(notificationMocks.success).toHaveBeenCalledOnce();
  });

  it("runs the standard workflow once without collecting page context", async () => {
    await runWorkflow("standard");

    expect(startAnalysis).toHaveBeenCalledOnce();
    expect(startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ collectPageContext: false }),
    );
  });

  it("stops before the next chapter when cancellation lands in a child-job gap", async () => {
    const options = makeOptions();
    options.flowCancellationRef = { current: false };
    const cancellationRef = options.flowCancellationRef;
    startAnalysis.mockImplementationOnce(async () => {
      cancellationRef.current = true;
      return { status: "completed" };
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    let outcome = "not-started";
    await act(async () => {
      outcome = await result.current.runTranslationFlow({
        selection: [
          { chapterId: "chapter-1", mode: "all" },
          { chapterId: "chapter-2", mode: "all" },
        ],
        workflowMode: "standard",
        blockMode: "auto",
      });
    });

    expect(outcome).toBe("cancelled");
    expect(startAnalysis).toHaveBeenCalledOnce();
  });
});
