import { expect, it, vi } from "vitest";
import { createLibraryRefreshCoordinator } from "../src/renderer/src/lib/libraryRefreshCoordinator";
import type { LibraryIndex } from "../src/shared/libraryTypes";

const emptyLibrary = (): LibraryIndex => ({ works: [], workOrder: [] });

function deferredLibrary() {
  let resolve!: (value: LibraryIndex) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<LibraryIndex>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

it("coalesces overlapping refreshes and publishes only the latest read", async () => {
  const first = deferredLibrary();
  const second = deferredLibrary();
  const read = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const publish = vi.fn();
  const coordinator = createLibraryRefreshCoordinator({
    read,
    publish,
    reportError: vi.fn(),
  });
  coordinator.request();
  coordinator.request();
  coordinator.request();
  expect(read).toHaveBeenCalledTimes(1);
  first.resolve(emptyLibrary());
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(publish).not.toHaveBeenCalled();
  const latest = emptyLibrary();
  second.resolve(latest);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(latest));
  expect(publish).toHaveBeenCalledTimes(1);
  coordinator.dispose();
});

it("reports a failed read and allows a later refresh to succeed", async () => {
  const failure = new Error("read failed");
  const library = emptyLibrary();
  const read = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(library);
  const publish = vi.fn();
  const reportError = vi.fn();
  const coordinator = createLibraryRefreshCoordinator({
    read,
    publish,
    reportError,
  });
  coordinator.request();
  await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(failure));
  coordinator.request();
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(library));
  coordinator.dispose();
});

it.each([false, true])(
  "ignores in-flight completion and queued reads after disposal (reject=%s)",
  async (reject) => {
    const pending = deferredLibrary();
    const read = vi.fn(() => pending.promise);
    const publish = vi.fn();
    const reportError = vi.fn();
    const coordinator = createLibraryRefreshCoordinator({
      read,
      publish,
      reportError,
    });
    coordinator.request();
    coordinator.request();
    coordinator.dispose();
    coordinator.request();
    if (reject) {
      pending.reject(new Error("disposed read failed"));
      await expect(pending.promise).rejects.toThrow("disposed read failed");
    } else {
      pending.resolve(emptyLibrary());
      await expect(pending.promise).resolves.toEqual(emptyLibrary());
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  },
);
