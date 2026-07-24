// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { UseLibraryActionsOptions } from "../src/renderer/src/hooks/libraryActionTypes";
import { useOpenChapterAction } from "../src/renderer/src/hooks/useOpenChapterAction";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const openChapter = vi.fn<(chapterId: string) => Promise<ChapterSnapshot>>();
const TS = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
  openChapter.mockReset();
  window.mangaApi = createTestMangaGatewayStub({ openChapter });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "mangaApi");
});

describe("useOpenChapterAction latest request policy", () => {
  it("keeps the most recent chapter when IPC responses finish out of order", async () => {
    const chapterA = makeChapter("chapter-a");
    const chapterB = makeChapter("chapter-b");
    const first = createDeferred<ChapterSnapshot>();
    const second = createDeferred<ChapterSnapshot>();
    openChapter
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const options = makeOptions();
    const { result } = renderHook(() => useOpenChapterAction(options));

    let openA!: Promise<void>;
    let openB!: Promise<void>;
    act(() => {
      openA = result.current(chapterA.id);
      openB = result.current(chapterB.id);
    });

    await act(async () => {
      second.resolve(chapterB);
      await openB;
    });
    await act(async () => {
      first.resolve(chapterA);
      await openA;
    });

    expect(openChapter).toHaveBeenNthCalledWith(1, chapterA.id);
    expect(openChapter).toHaveBeenNthCalledWith(2, chapterB.id);
    expect(options.setCurrentChapter).toHaveBeenCalledTimes(1);
    expect(options.setCurrentChapter).toHaveBeenCalledWith(chapterB);
    expect(options.currentChapterRef.current).toBe(chapterB);
  });

  it("invalidates a pending selection when the user reselects the current chapter", async () => {
    const pending = createDeferred<ChapterSnapshot>();
    openChapter.mockReturnValueOnce(pending.promise);
    const options = makeOptions();
    const currentChapter = options.currentChapterRef.current;
    if (!currentChapter) {
      throw new Error("Expected a current chapter fixture.");
    }
    const { result } = renderHook(() => useOpenChapterAction(options));

    let openPending!: Promise<void>;
    act(() => {
      openPending = result.current("chapter-pending");
      void result.current(currentChapter.id);
    });
    await act(async () => {
      pending.resolve(makeChapter("chapter-pending"));
      await openPending;
    });

    expect(options.setCurrentChapter).not.toHaveBeenCalled();
    expect(options.currentChapterRef.current).toBe(currentChapter);
  });

  it("does not start a stale chapter read after a queued save finishes", async () => {
    const delayedSave = createDeferred<void>();
    const chapterB = makeChapter("chapter-b");
    openChapter.mockResolvedValue(chapterB);
    const options = makeOptions();
    options.dirty = true;
    options.saveNow = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(delayedSave.promise)
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useOpenChapterAction(options));

    let openA!: Promise<void>;
    let openB!: Promise<void>;
    act(() => {
      openA = result.current("chapter-a");
      openB = result.current(chapterB.id);
    });
    await act(async () => {
      await openB;
    });

    expect(openChapter).toHaveBeenCalledOnce();
    expect(openChapter).toHaveBeenCalledWith(chapterB.id);

    await act(async () => {
      delayedSave.resolve();
      await openA;
    });

    expect(openChapter).toHaveBeenCalledOnce();
    expect(options.setCurrentChapter).toHaveBeenCalledOnce();
    expect(options.setCurrentChapter).toHaveBeenCalledWith(chapterB);
  });
});

function makeOptions(): UseLibraryActionsOptions {
  const currentChapter = makeChapter("chapter-current");
  return {
    askConfirm: vi.fn().mockResolvedValue(true),
    clearDirtyTracking: vi.fn(),
    clearPendingInpaintingMasks: vi.fn(),
    currentChapter,
    currentChapterRef: { current: currentChapter },
    dirty: false,
    hasPendingInpaintingMask: false,
    onChapterOpened: vi.fn(),
    pushStatus: vi.fn(),
    resetSaveBaseline: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    library: { workOrder: [], works: [] },
    setCurrentChapter: vi.fn(),
    setLibrary: vi.fn(),
    setSelectedBlockId: vi.fn(),
    setSelectedPageId: vi.fn(),
  };
}

function makeChapter(id: string): ChapterSnapshot {
  return {
    id,
    workId: "work-1",
    title: id,
    sourceKind: "images",
    status: "completed",
    pageOrder: [],
    pages: [],
    createdAt: TS,
    updatedAt: TS,
  };
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
