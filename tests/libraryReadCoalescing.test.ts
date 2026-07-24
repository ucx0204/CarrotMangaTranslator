import { describe, expect, it, vi } from "vitest";
import { createListLibrary } from "../src/main/library/libraryReadFacade";
import type { LibraryIndex } from "../src/shared/libraryTypes";

describe("library index read coalescing", () => {
  it("shares one in-flight read and starts a fresh read after completion", async () => {
    const first = createDeferred<LibraryIndex>();
    const second = createDeferred<LibraryIndex>();
    const load = vi
      .fn<() => Promise<LibraryIndex>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const listLibrary = createListLibrary(load);

    const firstCall = listLibrary();
    const duplicateCall = listLibrary();

    expect(duplicateCall).toBe(firstCall);
    expect(load).toHaveBeenCalledOnce();

    first.resolve(emptyLibrary());
    await expect(Promise.all([firstCall, duplicateCall])).resolves.toEqual([
      emptyLibrary(),
      emptyLibrary(),
    ]);

    const nextCall = listLibrary();
    expect(load).toHaveBeenCalledTimes(2);
    second.resolve(emptyLibrary());
    await expect(nextCall).resolves.toEqual(emptyLibrary());
  });

  it("propagates a shared failure and clears it for retry", async () => {
    const failed = createDeferred<LibraryIndex>();
    const recovered = emptyLibrary();
    const load = vi
      .fn<() => Promise<LibraryIndex>>()
      .mockReturnValueOnce(failed.promise)
      .mockResolvedValueOnce(recovered);
    const listLibrary = createListLibrary(load);

    const firstCall = listLibrary();
    const duplicateCall = listLibrary();
    const failure = new Error("library unavailable");
    failed.reject(failure);

    await expect(
      Promise.allSettled([firstCall, duplicateCall]),
    ).resolves.toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);

    await expect(listLibrary()).resolves.toEqual(recovered);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

function emptyLibrary(): LibraryIndex {
  return { workOrder: [], works: [] };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}
