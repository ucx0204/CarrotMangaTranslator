// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { UseInpaintingActionsOptions } from "../src/renderer/src/hooks/inpaintingActionTypes";

const startInpainting = vi.fn();
const revertInpainting = vi.fn();
const applyInpaintingHistoryTransaction = vi.fn();

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    applyInpaintingHistoryTransaction,
    revertInpainting,
    startInpainting,
  });
});

import { useRevertInpaintingAction } from "../src/renderer/src/hooks/useRevertInpaintingAction";
import { useRunBubbleLayoutAction } from "../src/renderer/src/hooks/useRunBubbleLayoutAction";
import { useRunInpaintingAction } from "../src/renderer/src/hooks/useRunInpaintingAction";
import { useRunInpaintingSelectionAction } from "../src/renderer/src/hooks/useRunInpaintingSelectionAction";
import { useInpaintingActions } from "../src/renderer/src/hooks/useInpaintingActions";

const TS = "2026-01-01T00:00:00.000Z";

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "C:/page.png",
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [],
    analysisStatus: "completed",
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
    status: "completed",
    pageOrder: [page.id],
    pages: [page],
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeOptions(
  overrides: Partial<UseInpaintingActionsOptions> = {},
): UseInpaintingActionsOptions {
  return {
    askConfirm: vi.fn().mockResolvedValue(true),
    clearPageImageCache: vi.fn(),
    clearRetouchHistory: vi.fn(),
    currentChapter: makeChapter(),
    dirty: true,
    jobActive: false,
    mergeLiveChapter: vi.fn(),
    patternMaskStrokes: [],
    pushStatus: vi.fn(),
    refreshLibrary: vi.fn().mockResolvedValue(undefined),
    saveNow: vi.fn().mockResolvedValue(undefined),
    selectedPage: makePage(),
    setFlowActive: vi.fn(),
    setInpaintingTool: vi.fn(),
    setJobState: vi.fn(),
    setPatternMaskStrokesByPage: vi.fn(),
    setPeekOriginal: vi.fn(),
    setShowBlockChrome: vi.fn(),
    workspaceHistory: { recordImageEdit: vi.fn() },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  startInpainting.mockReset();
  revertInpainting.mockReset();
  applyInpaintingHistoryTransaction.mockReset();
  vi.clearAllMocks();
});

describe("useRunInpaintingSelectionAction", () => {
  it("treats the picker start as confirmation and records the batch once", async () => {
    const options = makeOptions();
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [makeChapter()],
      pagesChanged: 1,
      blocksErased: 2,
      historyTransaction: { transactionId: "tx-batch" },
    });
    const { result } = renderHook(() =>
      useRunInpaintingSelectionAction(options),
    );

    await act(() =>
      result.current([
        { chapterId: "chapter-1", mode: "page-set", pageIds: ["page-1"] },
      ]),
    );

    expect(options.saveNow).toHaveBeenCalledOnce();
    expect(options.askConfirm).not.toHaveBeenCalled();
    expect(options.setPeekOriginal).toHaveBeenCalledWith(false);
    expect(startInpainting).toHaveBeenCalledWith({
      mode: "selection-pattern",
      workId: "work-1",
      selections: [
        { chapterId: "chapter-1", mode: "page-set", pageIds: ["page-1"] },
      ],
    });
    expect(options.mergeLiveChapter).toHaveBeenCalledWith(makeChapter());
    expect(options.refreshLibrary).toHaveBeenCalledOnce();
    expect(options.workspaceHistory.recordImageEdit).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: "tx-batch" }),
    );
    expect(options.setFlowActive).toHaveBeenNthCalledWith(1, true);
    expect(options.setFlowActive).toHaveBeenLastCalledWith(false);
    expect(options.setJobState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "inpainting-flow-completed",
        status: "completed",
      }),
    );
    expect(options.pushStatus).toHaveBeenCalledOnce();
    expect(vi.mocked(options.saveNow).mock.invocationCallOrder[0]).toBeLessThan(
      startInpainting.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("stops the chapter sequence at the first failed result", async () => {
    const options = makeOptions();
    const chapter2 = {
      ...makeChapter(),
      id: "chapter-2",
      title: "2화",
    };
    startInpainting
      .mockResolvedValueOnce({
        status: "completed",
        chapters: [makeChapter()],
        pagesChanged: 1,
        blocksErased: 1,
        historyTransaction: { transactionId: "tx-1" },
      })
      .mockResolvedValueOnce({
        status: "failed",
        error: "chapter 2 failed",
        chapters: [chapter2],
        historyTransaction: { transactionId: "tx-2" },
      });
    const { result } = renderHook(() =>
      useRunInpaintingSelectionAction(options),
    );

    await act(() =>
      result.current(
        [
          { chapterId: "chapter-1", mode: "all" },
          { chapterId: "chapter-2", mode: "all" },
          { chapterId: "chapter-3", mode: "all" },
        ],
        {
          bubbleLayout: { enabled: true, policy: "balanced" },
        },
      ),
    );

    expect(startInpainting).toHaveBeenCalledTimes(2);
    expect(
      startInpainting.mock.calls.map(([request]) => request.selections),
    ).toEqual([
      [{ chapterId: "chapter-1", mode: "all" }],
      [{ chapterId: "chapter-2", mode: "all" }],
    ]);
    expect(options.workspaceHistory.recordImageEdit).toHaveBeenCalledTimes(2);
    expect(options.setJobState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "inpainting-flow-failed",
        status: "failed",
        detail: "chapter 2 failed",
      }),
    );
    expect(options.setShowBlockChrome).not.toHaveBeenCalled();
    expect(options.refreshLibrary).toHaveBeenCalledOnce();
  });

  it("stops immediately on cancellation and leaves aggregate state cancelled", async () => {
    const options = makeOptions();
    startInpainting
      .mockResolvedValueOnce({
        status: "completed",
        chapters: [makeChapter()],
        pagesChanged: 1,
        blocksErased: 1,
      })
      .mockResolvedValueOnce({ status: "cancelled" });
    const { result } = renderHook(() =>
      useRunInpaintingSelectionAction(options),
    );

    await act(() =>
      result.current([
        { chapterId: "chapter-1", mode: "all" },
        { chapterId: "chapter-2", mode: "all" },
        { chapterId: "chapter-3", mode: "all" },
      ]),
    );

    expect(startInpainting).toHaveBeenCalledTimes(2);
    expect(options.setJobState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "inpainting-flow-cancelled",
        status: "cancelled",
      }),
    );
    expect(options.setFlowActive).toHaveBeenLastCalledWith(false);
  });

  it("does not start when saving dirty edits fails", async () => {
    const options = makeOptions({
      saveNow: vi.fn().mockRejectedValue(new Error("save failed")),
    });
    const { result } = renderHook(() =>
      useRunInpaintingSelectionAction(options),
    );

    await act(() => result.current([{ chapterId: "chapter-1", mode: "all" }]));

    expect(startInpainting).not.toHaveBeenCalled();
    expect(options.setPeekOriginal).not.toHaveBeenCalled();
    expect(options.setJobState).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("passes bubble postprocess and hides edit chrome after completion", async () => {
    const options = makeOptions();
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [makeChapter()],
      pagesChanged: 1,
      blocksErased: 2,
    });
    const { result } = renderHook(() =>
      useRunInpaintingSelectionAction(options),
    );
    const postprocess = {
      bubbleLayout: { enabled: true, policy: "balanced" as const },
    };

    await act(() =>
      result.current([{ chapterId: "chapter-1", mode: "all" }], postprocess),
    );

    expect(startInpainting).toHaveBeenCalledWith({
      mode: "selection-pattern",
      workId: "work-1",
      selections: [{ chapterId: "chapter-1", mode: "all" }],
      postprocess,
    });
    expect(options.setShowBlockChrome).toHaveBeenCalledWith(false);
  });
});

describe("useInpaintingActions refresh queue", () => {
  it("commits sequential page results immediately without staging a result preview", async () => {
    const options = makeOptions();
    const secondChapter = {
      ...makeChapter(),
      id: "chapter-2",
      title: "2화",
    };
    applyInpaintingHistoryTransaction.mockResolvedValue({
      chapters: [makeChapter()],
      invalidated: false,
    });
    startInpainting
      .mockResolvedValueOnce({
        status: "completed",
        chapters: [makeChapter()],
        pagesChanged: 1,
        blocksErased: 1,
        historyTransaction: { transactionId: "tx-page-1" },
      })
      .mockResolvedValueOnce({
        status: "completed",
        chapters: [secondChapter],
        pagesChanged: 1,
        blocksErased: 1,
        historyTransaction: { transactionId: "tx-page-2" },
      });
    const { result } = renderHook(() => useInpaintingActions(options));

    await act(() =>
      result.current.runInpaintingSelection([
        { chapterId: "chapter-1", mode: "page-set", pageIds: ["page-1"] },
        { chapterId: "chapter-2", mode: "page-set", pageIds: ["page-2"] },
      ]),
    );

    expect(applyInpaintingHistoryTransaction).not.toHaveBeenCalled();
    expect(options.mergeLiveChapter).toHaveBeenCalledOnce();
    expect(options.mergeLiveChapter).toHaveBeenCalledWith(makeChapter());
    expect(options.workspaceHistory.recordImageEdit).toHaveBeenCalledTimes(2);
    expect(options.workspaceHistory.recordImageEdit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chapterId: "chapter-1",
        transactionId: "tx-page-1",
      }),
    );
    expect(options.workspaceHistory.recordImageEdit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chapterId: "chapter-2",
        transactionId: "tx-page-2",
      }),
    );
    expect(options.setJobState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "inpainting-flow-completed",
        status: "completed",
      }),
    );
  });

  it("unlocks actions before refresh completes and serializes later refreshes", async () => {
    const firstRefresh = createVoidDeferred();
    const secondRefresh = createVoidDeferred();
    const refreshLibrary = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(firstRefresh.promise)
      .mockReturnValueOnce(secondRefresh.promise);
    const options = makeOptions({ refreshLibrary });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapter: makeChapter(),
      pagesChanged: 1,
      blocksErased: 1,
    });
    const { result } = renderHook(() => useInpaintingActions(options));

    await act(() => result.current.runInpainting("page"));
    expect(result.current.actionBusy).toBe(false);
    expect(refreshLibrary).toHaveBeenCalledOnce();

    await act(() => result.current.runInpainting("page"));
    expect(result.current.actionBusy).toBe(false);
    expect(startInpainting).toHaveBeenCalledTimes(2);
    expect(refreshLibrary).toHaveBeenCalledOnce();

    await act(async () => {
      firstRefresh.resolve();
      await Promise.resolve();
    });
    expect(refreshLibrary).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondRefresh.resolve();
      await Promise.resolve();
    });
  });
});

describe("original comparison during page operations", () => {
  it("clears original comparison before current-page automatic erase starts", async () => {
    const options = makeOptions();
    startInpainting.mockResolvedValue({
      status: "completed",
      chapter: makeChapter(),
      pagesChanged: 1,
      blocksErased: 2,
      historyTransaction: { transactionId: "tx-page" },
    });
    const { result } = renderHook(() => useRunInpaintingAction(options));

    await act(() => result.current("page"));

    expect(options.askConfirm).toHaveBeenCalledOnce();
    expect(options.setPeekOriginal).toHaveBeenCalledWith(false);
    expect(startInpainting).toHaveBeenCalledWith({
      chapterId: "chapter-1",
      mode: "page-pattern",
      pageId: "page-1",
    });
    expect(
      vi.mocked(options.setPeekOriginal).mock.invocationCallOrder[0],
    ).toBeLessThan(startInpainting.mock.invocationCallOrder[0] ?? 0);
  });

  it("limits automatic erase to the requested text block", async () => {
    const page = { ...makePage(), blocks: [makeBlock()] };
    const chapter = { ...makeChapter(), pages: [page] };
    const options = makeOptions({
      currentChapter: chapter,
      selectedPage: page,
    });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapter,
      pagesChanged: 1,
      blocksErased: 1,
    });
    const { result } = renderHook(() => useRunInpaintingAction(options));

    await act(() => result.current("page", "block-1"));

    expect(startInpainting).toHaveBeenCalledWith({
      blockId: "block-1",
      chapterId: "chapter-1",
      mode: "page-pattern",
      pageId: "page-1",
    });
    expect(options.askConfirm).toHaveBeenCalledWith(
      "원문 지우기",
      expect.stringContaining("선택한 텍스트 블록"),
      expect.any(String),
    );
  });

  it("clears original comparison before resetting the page", async () => {
    const options = makeOptions();
    revertInpainting.mockResolvedValue({
      chapter: makeChapter(),
      pagesChanged: 1,
      historyTransaction: { transactionId: "tx-reset" },
    });
    const { result } = renderHook(() => useRevertInpaintingAction(options));

    await act(() => result.current("page"));

    expect(options.askConfirm).toHaveBeenCalledOnce();
    expect(options.setPeekOriginal).toHaveBeenCalledWith(false);
    expect(revertInpainting).toHaveBeenCalledWith({
      chapterId: "chapter-1",
      scope: "page",
      pageId: "page-1",
    });
    expect(options.workspaceHistory.recordImageEdit).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: "tx-reset" }),
    );
  });
});

describe("useRunBubbleLayoutAction", () => {
  it("runs balanced layout on the current page without requiring inpainting", async () => {
    const page = { ...makePage(), blocks: [makeBlock()] };
    const chapter = { ...makeChapter(), pages: [page] };
    const options = makeOptions({
      currentChapter: chapter,
      selectedPage: page,
    });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapter,
      historyTransaction: { transactionId: "tx-bubble-layout" },
    });
    const { result } = renderHook(() => useRunBubbleLayoutAction(options));

    await act(() => result.current());

    expect(options.askConfirm).not.toHaveBeenCalled();
    expect(startInpainting).toHaveBeenCalledWith({
      chapterId: "chapter-1",
      mode: "page-bubble-layout",
      pageId: "page-1",
      policy: "balanced",
    });
    expect(options.clearPageImageCache).toHaveBeenCalledOnce();
    expect(options.mergeLiveChapter).toHaveBeenCalledWith(chapter);
    expect(options.workspaceHistory.recordImageEdit).toHaveBeenCalledWith({
      label: "말풍선 맞춤 배치",
      transactionId: "tx-bubble-layout",
    });
    expect(options.setShowBlockChrome).toHaveBeenCalledWith(false);
  });

  it("limits bubble fitting to the requested text block", async () => {
    const page = { ...makePage(), blocks: [makeBlock()] };
    const chapter = { ...makeChapter(), pages: [page] };
    const options = makeOptions({
      currentChapter: chapter,
      selectedPage: page,
    });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapter,
    });
    const { result } = renderHook(() => useRunBubbleLayoutAction(options));

    await act(() => result.current("block-1"));

    expect(startInpainting).toHaveBeenCalledWith({
      blockId: "block-1",
      chapterId: "chapter-1",
      mode: "page-bubble-layout",
      pageId: "page-1",
      policy: "balanced",
    });
    expect(options.pushStatus).toHaveBeenCalledWith(
      "선택한 번역 블록을 말풍선에 맞췄습니다.",
    );
  });

  it("reports when no bubble area matches the requested text block", async () => {
    const page = { ...makePage(), blocks: [makeBlock()] };
    const chapter = { ...makeChapter(), pages: [page] };
    const options = makeOptions({
      currentChapter: chapter,
      selectedPage: page,
    });
    startInpainting.mockResolvedValue({
      status: "completed",
      blocksErased: 0,
    });
    const { result } = renderHook(() => useRunBubbleLayoutAction(options));

    await act(() => result.current("block-1"));

    expect(options.pushStatus).toHaveBeenCalledWith(
      "선택한 블록에서 맞출 말풍선 영역을 찾지 못했습니다.",
    );
    expect(options.setShowBlockChrome).not.toHaveBeenCalled();
  });

  it("explains why a page without text blocks cannot be laid out", async () => {
    const options = makeOptions();
    const { result } = renderHook(() => useRunBubbleLayoutAction(options));

    await act(() => result.current());

    expect(startInpainting).not.toHaveBeenCalled();
    expect(options.pushStatus).toHaveBeenCalledWith(
      "말풍선을 감지할 텍스트 블록이 없습니다.",
    );
  });
});

function makeBlock(): MangaPage["blocks"][number] {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 300, h: 200 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

function createVoidDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
