import { describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { createLiveChapterRefreshCoordinator } from "../src/renderer/src/lib/liveChapterRefreshCoordinator";

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
};

describe("live chapter refresh coordinator", () => {
  it("coalesces duplicate requests into one active and one trailing read", async () => {
    const firstRead = createDeferred<ChapterSnapshot>();
    const trailingRead = createDeferred<ChapterSnapshot>();
    const openChapter = vi
      .fn<(chapterId: string) => Promise<ChapterSnapshot>>()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(trailingRead.promise);
    const mergeLiveChapter = vi.fn();
    const coordinator = createLiveChapterRefreshCoordinator({
      getCurrentChapterId: () => "chapter-a",
      mergeLiveChapter,
      openChapter,
      reportError: vi.fn(),
    });

    coordinator.request();
    coordinator.request();
    coordinator.request();

    expect(openChapter).toHaveBeenCalledOnce();

    firstRead.resolve(makeChapter("chapter-a", "first"));
    await firstRead.promise;
    await flushMicrotasks();

    expect(openChapter).toHaveBeenCalledTimes(2);
    expect(openChapter).toHaveBeenLastCalledWith("chapter-a");

    trailingRead.resolve(makeChapter("chapter-a", "latest"));
    await trailingRead.promise;
    await flushMicrotasks();

    expect(openChapter).toHaveBeenCalledTimes(2);
    expect(mergeLiveChapter).toHaveBeenNthCalledWith(
      1,
      makeChapter("chapter-a", "first"),
    );
    expect(mergeLiveChapter).toHaveBeenNthCalledWith(
      2,
      makeChapter("chapter-a", "latest"),
    );
  });

  it("keeps chapter reads independent and only merges the current chapter", async () => {
    let currentChapterId = "chapter-a";
    const reads = new Map<string, Deferred<ChapterSnapshot>>();
    const openChapter = vi.fn((chapterId: string) => {
      const read = createDeferred<ChapterSnapshot>();
      reads.set(chapterId, read);
      return read.promise;
    });
    const mergeLiveChapter = vi.fn();
    const coordinator = createLiveChapterRefreshCoordinator({
      getCurrentChapterId: () => currentChapterId,
      mergeLiveChapter,
      openChapter,
      reportError: vi.fn(),
    });

    coordinator.request();
    currentChapterId = "chapter-b";
    coordinator.request();

    expect(openChapter).toHaveBeenCalledTimes(2);
    reads.get("chapter-a")?.resolve(makeChapter("chapter-a", "stale"));
    await flushMicrotasks();

    expect(mergeLiveChapter).not.toHaveBeenCalled();

    reads.get("chapter-b")?.resolve(makeChapter("chapter-b", "current"));
    await flushMicrotasks();

    expect(mergeLiveChapter).toHaveBeenCalledOnce();
    expect(mergeLiveChapter).toHaveBeenCalledWith(
      makeChapter("chapter-b", "current"),
    );
  });

  it("reports read failures and still performs the queued trailing read", async () => {
    const firstRead = createDeferred<ChapterSnapshot>();
    const trailingRead = createDeferred<ChapterSnapshot>();
    const failure = new Error("library read failed");
    const reportError = vi.fn();
    const mergeLiveChapter = vi.fn();
    const openChapter = vi
      .fn<(chapterId: string) => Promise<ChapterSnapshot>>()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(trailingRead.promise);
    const coordinator = createLiveChapterRefreshCoordinator({
      getCurrentChapterId: () => "chapter-a",
      mergeLiveChapter,
      openChapter,
      reportError,
    });

    coordinator.request();
    coordinator.request();
    firstRead.reject(failure);
    await expect(firstRead.promise).rejects.toBe(failure);
    await flushMicrotasks();

    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(openChapter).toHaveBeenCalledTimes(2);

    const latestChapter = makeChapter("chapter-a", "latest");
    trailingRead.resolve(latestChapter);
    await trailingRead.promise;
    await flushMicrotasks();

    expect(mergeLiveChapter).toHaveBeenCalledOnce();
    expect(mergeLiveChapter).toHaveBeenCalledWith(latestChapter);
  });
});

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: Deferred<T>["resolve"] | undefined;
  let rejectPromise: Deferred<T>["reject"] | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (!resolvePromise || !rejectPromise) {
    throw new Error("Failed to initialize deferred promise.");
  }
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeChapter(id: string, title: string): ChapterSnapshot {
  return {
    id,
    workId: "work-1",
    title,
    sourceKind: "images",
    status: "idle",
    pageOrder: [],
    pages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
