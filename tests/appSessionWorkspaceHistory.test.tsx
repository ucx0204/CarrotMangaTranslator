/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import {
  captureWorkspaceChapterEditSnapshot,
  captureWorkspaceMaskSnapshot,
} from "../src/renderer/src/lib/workspaceHistory";
import { makeBlock } from "./unifiedInpaintingUiFixtures";

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
  it.each(["other-page", "same-page", "handoff", "later-result"])(
    "replays only a compatible page basis (%s)",
    async (mode) => {
      const before = makeChapter("C:/chapter/page-after.png");
      const after = {
        ...before,
        pages: before.pages.map((page) => ({ ...page, blocks: [makeBlock()] })),
      };
      const selection = {
        selectedPageId: PAGE_ID,
        selectedBlockId: null,
        selectedBlockIds: [],
      };
      const controller = makeChapterController({
        chapter: after,
        clearPageImageCache: vi.fn(),
        mergeLiveChapter: vi.fn(),
        refreshLibrary: vi.fn(),
      });
      controller.derivedState.activities = {
        version: 1,
        pages:
          mode === "handoff"
            ? [
                {
                  jobId: "translation",
                  chapterId: CHAPTER_ID,
                  pageId: PAGE_ID,
                  phase: "finishing-edits",
                },
              ]
            : [],
        activities:
          mode === "later-result" || mode === "handoff"
            ? []
            : [
                {
                  id: "translation",
                  category: "job",
                  kind: "gemma-analysis",
                  mutatesLibrary: true,
                  blocksQuit: true,
                  startedAt: 0,
                  resources: [
                    {
                      kind: "page-content",
                      scope: `${CHAPTER_ID}/${mode === "same-page" ? PAGE_ID : "A"}`,
                      access: "write",
                    },
                  ],
                },
              ],
      };
      const { result, rerender } = renderHook(
        ({ session }) => useAppSessionWorkspaceHistory(session),
        { initialProps: { session: controller } },
      );
      act(() => {
        result.current.recordChapterEdit({
          label: "text",
          before: captureWorkspaceChapterEditSnapshot(before, selection, [
            PAGE_ID,
          ]),
          after: captureWorkspaceChapterEditSnapshot(after, selection, [
            PAGE_ID,
          ]),
        });
      });
      if (mode === "later-result") {
        controller.core.currentChapter = {
          ...after,
          pages: after.pages.map((page) => ({
            ...page,
            inpaintedImagePath: "C:/automatic.png",
          })),
        };
        controller.core.currentChapterRef.current =
          controller.core.currentChapter;
        rerender({ session: { ...controller, core: { ...controller.core } } });
      }
      await act(async () =>
        expect(await result.current.undo()).toBe(mode === "other-page"),
      );
      if (mode === "other-page") {
        expect(
          controller.core.currentChapterRef.current?.pages[0].blocks,
        ).toEqual([]);
        expect(controller.persistence.markDirty).toHaveBeenCalledWith(PAGE_ID);
        controller.core.currentChapter =
          controller.core.currentChapterRef.current;
        rerender({ session: { ...controller, core: { ...controller.core } } });
        await act(async () => expect(await result.current.redo()).toBe(true));
        expect(
          controller.core.currentChapterRef.current?.pages[0].blocks,
        ).toEqual(after.pages[0].blocks);
      } else {
        expect(controller.core.setCurrentChapter).not.toHaveBeenCalled();
        expect(controller.statusLog.pushStatus).toHaveBeenCalled();
      }
    },
  );

  it("permits mask draft undo during a page write but blocks its opaque image history", async () => {
    const controller = makeChapterController({
      chapter: makeChapter("C:/after.png"),
      clearPageImageCache: vi.fn(),
      mergeLiveChapter: vi.fn(),
      refreshLibrary: vi.fn(),
    });
    controller.derivedState.activities = {
      version: 1,
      pages: [],
      activities: [
        {
          id: "translation",
          category: "job",
          kind: "gemma-analysis",
          startedAt: 0,
          mutatesLibrary: true,
          blocksQuit: true,
          resources: [
            {
              kind: "page-content",
              scope: `${CHAPTER_ID}/${PAGE_ID}`,
              access: "write",
            },
          ],
        },
      ],
    };
    const { result } = renderHook(() =>
      useAppSessionWorkspaceHistory(controller),
    );
    act(() => {
      result.current.recordImageEdit({
        label: "brush",
        transactionId: TRANSACTION_ID,
        targets: [{ chapterId: CHAPTER_ID, pageId: PAGE_ID }],
      });
    });
    await act(async () => expect(await result.current.undo()).toBe(false));
    expect(applyHistoryTransaction).not.toHaveBeenCalled();
    act(() => {
      result.current.recordMaskEdit({
        label: "mask",
        before: captureWorkspaceMaskSnapshot(CHAPTER_ID, PAGE_ID, []),
        after: captureWorkspaceMaskSnapshot(CHAPTER_ID, PAGE_ID, [
          { points: [{ x: 5, y: 5 }], radiusPx: 3 },
        ]),
      });
    });
    await act(async () => expect(await result.current.undo()).toBe(true));
    const update = vi.mocked(controller.uiState.setPatternMaskStrokesByPage)
      .mock.calls[0][0];
    if (typeof update !== "function") throw new Error("Expected mask update");
    expect(
      update({ [PAGE_ID]: [{ points: [{ x: 5, y: 5 }], radiusPx: 3 }] }),
    ).toEqual({});
  });
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
