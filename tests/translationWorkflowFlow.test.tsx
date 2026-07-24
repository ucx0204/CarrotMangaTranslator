// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { NotificationPort } from "../src/renderer/src/lib/notificationPort";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationWorkflowMode } from "../src/shared/settingsTypes";
import type { UseTranslationActionsOptions } from "../src/renderer/src/hooks/translationActionTypes";

const startAnalysis = vi.fn();
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
    startAnalysis,
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
    clearStatusLines: vi.fn(),
    currentChapter: chapter,
    currentChapterRef: { current: chapter },
    jobActive: false,
    library: { workOrder: [], works: [] },
    mergeLiveChapter: vi.fn(),
    pushStatus: vi.fn(),
    refreshLibrary: vi.fn().mockResolvedValue(undefined),
    saveNow: vi.fn().mockResolvedValue(undefined),
    selectedPage: null,
    setCurrentChapter: vi.fn(),
    setFlowActive: vi.fn(),
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
