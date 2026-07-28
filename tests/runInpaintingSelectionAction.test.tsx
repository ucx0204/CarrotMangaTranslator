// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { UseInpaintingActionsOptions } from "../src/renderer/src/hooks/inpaintingActionTypes";

const startInpainting = vi.fn();
const revertInpainting = vi.fn();

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
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
    expect(vi.mocked(options.saveNow).mock.invocationCallOrder[0]).toBeLessThan(
      startInpainting.mock.invocationCallOrder[0] ?? 0,
    );
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
