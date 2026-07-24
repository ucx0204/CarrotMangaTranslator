/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";

const applyHistoryTransaction = vi.fn();
const releaseHistoryTransactions = vi.fn();

import { useAppSessionWorkspaceHistory } from "../src/renderer/src/app/session/useAppSessionWorkspaceHistory";
import type { WorkspaceHistoryChapterController } from "../src/renderer/src/app/session/useAppSessionWorkspaceHistory";

const CHAPTER_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const TRANSACTION_ID = "33333333-3333-4333-8333-333333333333";
const TS = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "mangaApi");
});

beforeEach(() => {
  applyHistoryTransaction.mockReset();
  releaseHistoryTransactions.mockReset();
  releaseHistoryTransactions.mockResolvedValue({ released: 0 });
  window.mangaApi = createTestMangaGatewayStub({
    applyInpaintingHistoryTransaction: applyHistoryTransaction,
    releaseInpaintingHistoryTransactions: releaseHistoryTransactions,
  });
});

describe("app-session workspace history", () => {
  it("keeps history actions stable when only session aggregate objects change", () => {
    const chapter = makeChapter("C:/chapter/page-after.png");
    const pageOrderJoin = vi.spyOn(chapter.pageOrder, "join");
    const controller = makeChapterController({
      chapter,
      clearPageImageCache: vi.fn(),
      mergeLiveChapter: vi.fn(),
      refreshLibrary: vi.fn().mockResolvedValue(undefined),
    });
    const { result, rerender } = renderHook(
      ({ session }: { session: WorkspaceHistoryChapterController }) =>
        useAppSessionWorkspaceHistory(session),
      { initialProps: { session: controller } },
    );
    const initialHistory = result.current;
    pageOrderJoin.mockClear();

    rerender({
      session: {
        ...controller,
        core: { ...controller.core },
        persistence: { ...controller.persistence },
      },
    });

    expect(result.current).toBe(initialHistory);
    expect(pageOrderJoin).not.toHaveBeenCalled();
  });

  it("merges authoritative chapters and discards an invalidated image entry", async () => {
    const before = makeChapter("C:/chapter/page-after.png");
    const authoritative = makeChapter("C:/chapter/page-uncertain.png");
    const mergeLiveChapter = vi.fn();
    const clearPageImageCache = vi.fn();
    const refreshLibrary = vi.fn().mockResolvedValue(undefined);
    applyHistoryTransaction.mockResolvedValue({
      transactionId: TRANSACTION_ID,
      direction: "undo",
      chapters: [authoritative],
      pagesChanged: 1,
      invalidated: true,
    });
    const chapter = makeChapterController({
      chapter: before,
      clearPageImageCache,
      mergeLiveChapter,
      refreshLibrary,
    });

    const { result } = renderHook(() => useAppSessionWorkspaceHistory(chapter));
    act(() => {
      result.current.recordImageEdit({
        label: "자동 지우기",
        transactionId: TRANSACTION_ID,
      });
    });

    await act(async () => {
      expect(await result.current.undo()).toBe(false);
    });

    expect(applyHistoryTransaction).toHaveBeenCalledWith({
      transactionId: TRANSACTION_ID,
      direction: "undo",
    });
    expect(clearPageImageCache).toHaveBeenCalledOnce();
    expect(mergeLiveChapter).toHaveBeenCalledWith(authoritative);
    expect(refreshLibrary).toHaveBeenCalledOnce();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(releaseHistoryTransactions).not.toHaveBeenCalled();
  });

  it("resets and releases history when page order changes in the same chapter", () => {
    const chapter = makeChapter("C:/chapter/page-after.png");
    const controller = makeChapterController({
      chapter,
      clearPageImageCache: vi.fn(),
      mergeLiveChapter: vi.fn(),
      refreshLibrary: vi.fn().mockResolvedValue(undefined),
    });
    const { result, rerender } = renderHook(
      ({ session }: { session: WorkspaceHistoryChapterController }) =>
        useAppSessionWorkspaceHistory(session),
      { initialProps: { session: controller } },
    );
    act(() => {
      result.current.recordImageEdit({
        label: "자동 지우기",
        transactionId: TRANSACTION_ID,
      });
    });

    const reordered = {
      ...chapter,
      pageOrder: [PAGE_ID, "55555555-5555-4555-8555-555555555555"],
    };
    rerender({
      session: makeChapterController({
        chapter: reordered,
        clearPageImageCache: vi.fn(),
        mergeLiveChapter: vi.fn(),
        refreshLibrary: vi.fn().mockResolvedValue(undefined),
      }),
    });

    expect(result.current.canUndo).toBe(false);
    expect(releaseHistoryTransactions).toHaveBeenCalledWith({
      transactionIds: [TRANSACTION_ID],
    });
  });
});

function makeChapterController({
  chapter,
  clearPageImageCache,
  mergeLiveChapter,
  refreshLibrary,
}: {
  chapter: ChapterSnapshot;
  clearPageImageCache: () => void;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  refreshLibrary: () => Promise<void>;
}): WorkspaceHistoryChapterController {
  return {
    core: {
      currentChapter: chapter,
      currentChapterRef: { current: chapter },
      selectedPageIdRef: { current: PAGE_ID },
      selectedBlockIdRef: { current: null },
      setCurrentChapter: vi.fn(),
      setSelectedPageId: vi.fn(),
      setSelectedBlockId: vi.fn(),
      setSelectedBlockIds: vi.fn(),
    },
    derivedState: { clearPageImageCache },
    libraryActions: { refreshLibrary },
    mergeLiveChapter,
    persistence: { markDirty: vi.fn() },
    statusLog: { pushStatus: vi.fn() },
    uiState: { setPatternMaskStrokesByPage: vi.fn() },
  } satisfies WorkspaceHistoryChapterController;
}

function makeChapter(inpaintedImagePath: string): ChapterSnapshot {
  const page: MangaPage = {
    id: PAGE_ID,
    name: "page.png",
    imagePath: "C:/chapter/page.png",
    inpaintedImagePath,
    dataUrl: "data:image/png;base64,AA==",
    width: 10,
    height: 10,
    blocks: [],
    analysisStatus: "completed",
    createdAt: TS,
    updatedAt: TS,
  };
  return {
    id: CHAPTER_ID,
    workId: "44444444-4444-4444-8444-444444444444",
    title: "Chapter",
    sourceKind: "images",
    status: "completed",
    pageOrder: [PAGE_ID],
    pages: [page],
    createdAt: TS,
    updatedAt: TS,
  };
}
