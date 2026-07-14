/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceChapterEditSnapshot,
  WorkspaceMaskSnapshot,
} from "../src/renderer/src/lib/workspaceHistory";
import {
  useWorkspaceHistory,
  type UseWorkspaceHistoryOptions,
} from "../src/renderer/src/hooks/useWorkspaceHistory";

afterEach(cleanup);

describe("useWorkspaceHistory", () => {
  it("replays mixed operations through one controller and exposes next labels", async () => {
    const handlers = makeHandlers();
    const { result } = renderHook(() =>
      useWorkspaceHistory({ chapterId: "chapter-1", ...handlers }),
    );
    const beforeChapter = chapterSnapshot("before");
    const afterChapter = chapterSnapshot("after");
    const beforeMask = maskSnapshot(0);
    const afterMask = maskSnapshot(1);

    act(() => {
      result.current.recordChapterEdit({
        label: "텍스트 편집",
        before: beforeChapter,
        after: afterChapter,
      });
      result.current.recordMaskEdit({
        label: "마스크 그리기",
        before: beforeMask,
        after: afterMask,
      });
      result.current.recordImageEdit({
        label: "마스크 Flux",
        transactionId: "transaction-1",
        mask: { before: afterMask, after: beforeMask },
      });
    });
    expect(result.current.undoLabel).toBe("마스크 Flux");

    await act(async () => {
      expect(await result.current.undo()).toBe(true);
    });
    expect(handlers.applyImageTransaction).toHaveBeenCalledWith({
      direction: "undo",
      transactionId: "transaction-1",
    });
    expect(handlers.applyMaskSnapshot).toHaveBeenLastCalledWith(afterMask);
    expect(result.current.undoLabel).toBe("마스크 그리기");
    expect(result.current.redoLabel).toBe("마스크 Flux");

    await act(async () => {
      expect(await result.current.undo()).toBe(true);
      expect(await result.current.undo()).toBe(true);
    });
    expect(handlers.applyMaskSnapshot).toHaveBeenLastCalledWith(beforeMask);
    expect(handlers.applyChapterSnapshot).toHaveBeenLastCalledWith(
      beforeChapter,
    );

    await act(async () => {
      expect(await result.current.redo()).toBe(true);
    });
    expect(handlers.applyChapterSnapshot).toHaveBeenLastCalledWith(
      afterChapter,
    );
  });

  it("leaves the entry available when an image transaction fails", async () => {
    const failure = new Error("revision conflict");
    const handlers = makeHandlers();
    handlers.applyImageTransaction.mockRejectedValue(failure);
    const onReplayError = vi.fn();
    const { result } = renderHook(() =>
      useWorkspaceHistory({
        chapterId: "chapter-1",
        ...handlers,
        onReplayError,
      }),
    );
    act(() => {
      result.current.recordImageEdit({
        label: "자동 Flux",
        transactionId: "transaction-1",
      });
    });

    await act(async () => {
      expect(await result.current.undo()).toBe(false);
    });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.undoLabel).toBe("자동 Flux");
    expect(onReplayError).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ transactionId: "transaction-1" }),
      "undo",
    );
  });

  it("drops an invalidated image entry and restores its local mask state", async () => {
    const handlers = makeHandlers();
    handlers.applyImageTransaction.mockResolvedValue("invalidated");
    const { result } = renderHook(() =>
      useWorkspaceHistory({ chapterId: "chapter-1", ...handlers }),
    );
    const beforeMask = maskSnapshot(1);
    const afterMask = maskSnapshot(0);
    act(() => {
      result.current.recordChapterEdit({
        label: "텍스트 편집",
        before: chapterSnapshot("before"),
        after: chapterSnapshot("after"),
      });
      result.current.recordImageEdit({
        label: "마스크 Flux",
        transactionId: "transaction-invalidated",
        mask: { before: beforeMask, after: afterMask },
      });
    });

    await act(async () => {
      expect(await result.current.undo()).toBe(false);
    });

    expect(handlers.applyMaskSnapshot).toHaveBeenNthCalledWith(1, beforeMask);
    expect(handlers.applyMaskSnapshot).toHaveBeenNthCalledWith(2, afterMask);
    expect(result.current.undoLabel).toBe("텍스트 편집");
    expect(result.current.canRedo).toBe(false);
    expect(handlers.releaseImageTransactions).not.toHaveBeenCalled();
  });

  it("serializes replay and rejects recording while an undo is pending", async () => {
    const deferred = createDeferred();
    const handlers = makeHandlers();
    handlers.applyImageTransaction.mockReturnValue(deferred.promise);
    const { result } = renderHook(() =>
      useWorkspaceHistory({ chapterId: "chapter-1", ...handlers }),
    );
    act(() => {
      result.current.recordImageEdit({
        label: "자동 Flux",
        transactionId: "transaction-1",
      });
    });

    let firstUndo: Promise<boolean> = Promise.resolve(false);
    act(() => {
      firstUndo = result.current.undo();
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      expect(await result.current.undo()).toBe(false);
    });
    expect(
      result.current.recordMaskEdit({
        label: "마스크",
        before: maskSnapshot(0),
        after: maskSnapshot(1),
      }),
    ).toBe(false);
    expect(
      result.current.recordImageEdit({
        label: "동시 이미지 작업",
        transactionId: "transaction-rejected",
      }),
    ).toBe(false);
    expect(handlers.releaseImageTransactions).toHaveBeenCalledWith([
      "transaction-rejected",
    ]);

    await act(async () => {
      deferred.resolve();
      expect(await firstUndo).toBe(true);
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it("releases image revisions when the open chapter changes", () => {
    const handlers = makeHandlers();
    const { result, rerender } = renderHook(
      ({ chapterId }: { chapterId: string }) =>
        useWorkspaceHistory({ chapterId, ...handlers }),
      { initialProps: { chapterId: "chapter-1" } },
    );
    act(() => {
      result.current.recordImageEdit({
        label: "브러시",
        transactionId: "transaction-1",
      });
    });

    rerender({ chapterId: "chapter-2" });
    expect(result.current.canUndo).toBe(false);
    expect(handlers.releaseImageTransactions).toHaveBeenCalledWith([
      "transaction-1",
    ]);
  });

  it("releases an image transaction when a new edit discards redo", async () => {
    const handlers = makeHandlers();
    const { result } = renderHook(() =>
      useWorkspaceHistory({ chapterId: "chapter-1", ...handlers }),
    );
    act(() => {
      result.current.recordImageEdit({
        label: "자동 Flux",
        transactionId: "transaction-redo",
      });
    });
    await act(async () => {
      expect(await result.current.undo()).toBe(true);
    });

    act(() => {
      result.current.recordChapterEdit({
        label: "텍스트 편집",
        before: chapterSnapshot("before"),
        after: chapterSnapshot("after"),
      });
    });

    expect(result.current.canRedo).toBe(false);
    expect(handlers.releaseImageTransactions).toHaveBeenCalledWith([
      "transaction-redo",
    ]);
  });

  it("releases image transactions evicted beyond the 60-entry limit", () => {
    const handlers = makeHandlers();
    const { result } = renderHook(() =>
      useWorkspaceHistory({ chapterId: "chapter-1", ...handlers }),
    );

    act(() => {
      for (let index = 0; index <= 60; index += 1) {
        result.current.recordImageEdit({
          label: `이미지 ${index}`,
          transactionId: `transaction-${index}`,
        });
      }
    });

    expect(handlers.releaseImageTransactions).toHaveBeenCalledTimes(1);
    expect(handlers.releaseImageTransactions).toHaveBeenCalledWith([
      "transaction-0",
    ]);
  });

  it("releases every retained image transaction when unmounted", () => {
    const handlers = makeHandlers();
    const { result, unmount } = renderHook(() =>
      useWorkspaceHistory({ chapterId: "chapter-1", ...handlers }),
    );
    act(() => {
      result.current.recordImageEdit({
        label: "자동 Flux",
        transactionId: "transaction-1",
      });
      result.current.recordImageEdit({
        label: "브러시",
        transactionId: "transaction-2",
      });
    });

    unmount();

    expect(handlers.releaseImageTransactions).toHaveBeenCalledWith([
      "transaction-1",
      "transaction-2",
    ]);
  });
});

function makeHandlers() {
  return {
    applyChapterSnapshot:
      vi.fn<(snapshot: WorkspaceChapterEditSnapshot) => void>(),
    applyMaskSnapshot: vi.fn<(snapshot: WorkspaceMaskSnapshot) => void>(),
    applyImageTransaction: vi
      .fn<UseWorkspaceHistoryOptions["applyImageTransaction"]>()
      .mockResolvedValue("applied"),
    releaseImageTransactions: vi.fn<(transactionIds: string[]) => void>(),
  };
}

function chapterSnapshot(
  selectedBlockId: string,
): WorkspaceChapterEditSnapshot {
  return {
    chapterId: "chapter-1",
    pages: [],
    selectedPageId: "page-1",
    selectedBlockId,
    selectedBlockIds: [selectedBlockId],
  };
}

function maskSnapshot(strokeCount: number): WorkspaceMaskSnapshot {
  return {
    chapterId: "chapter-1",
    pageId: "page-1",
    strokes: Array.from({ length: strokeCount }, () => ({
      points: [{ x: 1, y: 2 }],
      radiusPx: 12,
    })),
  };
}

function createDeferred(): {
  promise: Promise<"applied">;
  resolve: () => void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<"applied">((nextResolve) => {
    resolve = () => nextResolve("applied");
  });
  return { promise, resolve };
}
