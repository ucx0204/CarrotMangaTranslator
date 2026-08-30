import { describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { AsyncReaderWriterLock } from "../src/main/libraryStore/mutex";
import {
  createSavePageBlocks,
  updatePageProcessingTimings,
} from "../src/main/library/libraryMutationFacade";
import { createWorkShareExport } from "../src/main/library/libraryShareFacade";
import {
  withLibraryMutation,
  withLibraryNavigationRead,
} from "../src/main/library/lock";

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function waitForTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("AsyncReaderWriterLock", () => {
  it("runs queued reads concurrently", async () => {
    const lock = new AsyncReaderWriterLock();
    const releaseReads = createDeferred();
    let activeReads = 0;
    let peakReads = 0;

    const first = lock.runRead(async () => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await releaseReads.promise;
      activeReads -= 1;
      return "first";
    });
    const second = lock.runRead(async () => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await releaseReads.promise;
      activeReads -= 1;
      return "second";
    });

    await waitForTurn();

    expect(peakReads).toBe(2);

    releaseReads.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps writes exclusive and blocks later reads behind a queued write", async () => {
    const lock = new AsyncReaderWriterLock();
    const releaseInitialRead = createDeferred();
    const releaseWrite = createDeferred();
    const events: string[] = [];

    const initialRead = lock.runRead(async () => {
      events.push("read:start");
      await releaseInitialRead.promise;
      events.push("read:end");
    });

    await waitForTurn();

    const write = lock.runWrite(async () => {
      events.push("write:start");
      await releaseWrite.promise;
      events.push("write:end");
    });
    const laterRead = lock.runRead(async () => {
      events.push("later-read:start");
      return "later";
    });

    await waitForTurn();

    expect(events).toEqual(["read:start"]);

    releaseInitialRead.resolve();
    await initialRead;
    await waitForTurn();

    expect(events).toEqual(["read:start", "read:end", "write:start"]);

    releaseWrite.resolve();

    await expect(write).resolves.toBeUndefined();
    await expect(laterRead).resolves.toBe("later");
    expect(events).toEqual([
      "read:start",
      "read:end",
      "write:start",
      "write:end",
      "later-read:start",
    ]);
  });

  it("runs share exports through the read lock behind active mutations", async () => {
    const releaseMutation = createDeferred();
    const events: string[] = [];
    const lock = new AsyncReaderWriterLock();
    const exportWorkShareToFile = createWorkShareExport({
      runRead: (operation) => lock.runRead(operation),
      exportWorkShare: vi.fn(async () => {
        events.push("export:start");
        return {
          filePath: "share.mgtshare",
          workTitle: "원본 작품",
          chapterCount: 1,
          pageCount: 1,
        };
      }),
    });
    const savePageBlocksWithEvents = createSavePageBlocks({
      runMutation: (operation) => lock.runWrite(operation),
      savePageBlocks: vi.fn(async () => {
        events.push("write:start");
        await releaseMutation.promise;
        events.push("write:end");
        return {
          id: "chapter-a",
        } as ChapterSnapshot;
      }),
    });

    const mutation = savePageBlocksWithEvents({
      chapterId: "chapter-a",
      pageId: "page-a",
      blocks: [],
    });
    await waitForTurn();

    expect(events).toEqual(["write:start"]);

    const shareExport = exportWorkShareToFile({
      workId: "work-1",
      chapterIds: ["chapter-a"],
      outputPath: "share.mgtshare",
    });
    await waitForTurn();

    expect(events).toEqual(["write:start"]);

    releaseMutation.resolve();

    await expect(mutation).resolves.toMatchObject({ id: "chapter-a" });
    await expect(shareExport).resolves.toMatchObject({
      filePath: "share.mgtshare",
    });
    expect(events).toEqual(["write:start", "write:end", "export:start"]);
  });

  it("does not queue atomic navigation reads behind a retrying mutation", async () => {
    const releaseMutation = createDeferred();
    const events: string[] = [];
    const mutation = withLibraryMutation(async () => {
      events.push("write:start");
      await releaseMutation.promise;
      events.push("write:end");
    });
    await waitForTurn();

    const navigation = withLibraryNavigationRead(async () => {
      events.push("navigation:read");
      return "chapter snapshot";
    });

    await expect(navigation).resolves.toBe("chapter snapshot");
    expect(events).toEqual(["write:start", "navigation:read"]);

    releaseMutation.resolve();
    await mutation;
    expect(events).toEqual(["write:start", "navigation:read", "write:end"]);
  });

  it("routes timing-only updates through the mutation lock", async () => {
    await expect(updatePageProcessingTimings("chapter-a", [])).resolves.toEqual(
      new Set(),
    );
  });
});
