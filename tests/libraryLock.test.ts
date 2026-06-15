import { describe, expect, it } from "vitest";
import { AsyncReaderWriterLock } from "../src/main/libraryStore/mutex";

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
});
