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
const analyzeWorkContext = vi.fn();
const notificationMocks: NotificationPort = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
};

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    analyzeWorkContext,
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
  analyzeWorkContext.mockResolvedValue(undefined);
  const { result } = renderHook(() =>
    useTranslationActions(options, notificationMocks),
  );

  await act(async () => {
    await result.current.runTranslationFlow({
      selection: [{ chapterId: "chapter-1", mode: "pending" }],
      workflowMode,
      analysisScope: "missing",
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
        analysisScope: "missing",
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
          pageIds: ["page-1"],
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
    expect(options.mergeLiveChapter).toHaveBeenCalledWith(completedChapter);
    expect(options.clearRetouchHistory).toHaveBeenCalledOnce();
    expect(options.recordImageEdit).toHaveBeenCalledWith({
      label: "자동 지우기",
      transactionId: "tx-translation-layout",
    });
    expect(options.setShowBlockChrome).toHaveBeenCalledWith(false);
  });

  it("can erase translated source text without running bubble postprocess", async () => {
    const options = makeOptions();
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [makeChapter()],
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "all" }],
        workflowMode: "cumulative",
        analysisScope: "missing",
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
    });
    expect(notificationMocks.success).toHaveBeenCalledWith(
      "번역·원문 지우기를 완료했습니다.",
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
        analysisScope: "missing",
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
        analysisScope: "missing",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(outcome).toBe("failed");
    expect(startInpainting).not.toHaveBeenCalled();
    expect(options.setShowBlockChrome).not.toHaveBeenCalled();
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
        analysisScope: "missing",
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
        analysisScope: "missing",
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
    });
    expect(options.setShowBlockChrome).not.toHaveBeenCalled();
    expect(notificationMocks.success).not.toHaveBeenCalledWith(
      "번역·자동 지우기·말풍선 맞춤을 완료했습니다.",
    );
  });

  it("does not clear retouch history when Bubble workflow returns no live chapter", async () => {
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
        analysisScope: "missing",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(outcome).toBe("completed");
    expect(options.clearRetouchHistory).not.toHaveBeenCalled();
    expect(options.clearPageImageCache).not.toHaveBeenCalled();
    expect(options.mergeLiveChapter).not.toHaveBeenCalled();
    expect(options.setShowBlockChrome).toHaveBeenCalledWith(false);
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

  it("forwards natural layout through both precision passes", async () => {
    const options = makeOptions();
    startAnalysis.mockResolvedValue({ status: "completed" });
    analyzeWorkContext.mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "pending" }],
        workflowMode: "two-pass",
        analysisScope: "missing",
        blockMode: "auto",
        naturalTextLayout: true,
      });
    });

    expect(startAnalysis).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ naturalTextLayout: true }),
    );
    expect(startAnalysis).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ naturalTextLayout: true }),
    );
  });

  it("defers natural hard breaks until Bubble postprocess knows the final shape", async () => {
    const options = makeOptions();
    openChapter.mockResolvedValue(makeChapter());
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [makeChapter()],
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "all" }],
        workflowMode: "cumulative",
        analysisScope: "missing",
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
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "all" }],
        workflowMode: "cumulative",
        analysisScope: "missing",
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

  it("runs the full precise flow for direct entry points with a two-pass default", async () => {
    const options = {
      ...makeOptions(),
      translationWorkflowDefault: "two-pass" as const,
      analysisScopeDefault: "chapter" as const,
      blockModeDefault: "keep" as const,
    };
    startAnalysis.mockResolvedValue({ status: "completed" });
    analyzeWorkContext.mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runAnalysis("pending");
    });

    expect(startAnalysis).toHaveBeenCalledTimes(2);
    expect(startAnalysis).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        runMode: "pending",
        blockMode: "keep",
        collectPageContext: false,
      }),
    );
    expect(analyzeWorkContext).toHaveBeenCalledWith({
      chapterId: "chapter-1",
      scope: "chapter",
    });
    expect(startAnalysis).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runMode: "all",
        blockMode: "keep",
        collectPageContext: false,
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
    expect(analyzeWorkContext).not.toHaveBeenCalled();
    expect(notificationMocks.success).toHaveBeenCalledOnce();
  });

  it("runs the standard workflow once without collecting page context", async () => {
    await runWorkflow("standard");

    expect(startAnalysis).toHaveBeenCalledOnce();
    expect(startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ collectPageContext: false }),
    );
    expect(analyzeWorkContext).not.toHaveBeenCalled();
  });

  it("keeps both precision passes free of page-context collection", async () => {
    await runWorkflow("two-pass");

    expect(startAnalysis).toHaveBeenCalledTimes(2);
    expect(startAnalysis).toHaveBeenNthCalledWith(1, {
      chapterId: "chapter-1",
      runMode: "pending",
      blockMode: "auto",
      collectPageContext: false,
    });
    expect(analyzeWorkContext).toHaveBeenCalledWith({
      chapterId: "chapter-1",
      scope: "missing",
    });
    expect(startAnalysis).toHaveBeenNthCalledWith(2, {
      chapterId: "chapter-1",
      runMode: "all",
      blockMode: "auto",
      collectPageContext: false,
    });
    expect(notificationMocks.success).toHaveBeenCalledOnce();
  });

  it("keeps the first-pass state and reports a context-analysis failure", async () => {
    const options = makeOptions();
    startAnalysis.mockResolvedValue({ status: "completed" });
    analyzeWorkContext.mockRejectedValueOnce(new Error("analysis failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    let outcome = "not-started";
    await act(async () => {
      outcome = await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "pending" }],
        workflowMode: "two-pass",
        analysisScope: "missing",
        blockMode: "auto",
      });
    });

    expect(outcome).toBe("failed");
    expect(startAnalysis).toHaveBeenCalledOnce();
    expect(options.setJobState).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "flow-analysis-skipped",
        status: "completed",
      }),
    );
    expect(notificationMocks.error).toHaveBeenCalledOnce();
    expect(options.setFlowActive).toHaveBeenLastCalledWith(false);
  });
});
