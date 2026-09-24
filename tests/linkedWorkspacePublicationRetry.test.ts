import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  rename: native.rename,
}));
import { renameWithTransientRetry } from "../src/main/libraryStore/storage";

beforeEach(() => {
  vi.useFakeTimers();
  native.rename.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("reviewed rename retry authority", () => {
  it("rechecks a live guard before the next Windows transient retry", async () => {
    const attempted = deferred();
    native.rename
      .mockImplementationOnce(async () => {
        attempted.resolve();
        throw Object.assign(new Error("busy"), { code: "EPERM" });
      })
      .mockResolvedValue(undefined);
    let allowed = true;
    const guard = vi.fn(async () => {
      if (!allowed) throw new Error("revoked");
    });
    const operation = renameWithTransientRetry(
      "owned-temp",
      "approved-target",
      undefined,
      guard,
    );
    const rejected = expect(operation).rejects.toThrow("revoked");
    await attempted.promise;
    allowed = false;
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(native.rename).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("does not retry after cancellation during the existing backoff", async () => {
    const attempted = deferred();
    native.rename.mockImplementationOnce(async () => {
      attempted.resolve();
      throw Object.assign(new Error("busy"), { code: "EACCES" });
    });
    const controller = new AbortController();
    const guard = vi.fn(async () => undefined);
    const operation = renameWithTransientRetry(
      "owned-temp",
      "approved-target",
      controller.signal,
      guard,
    );
    const rejected = expect(operation).rejects.toMatchObject({
      name: "AbortError",
    });
    await attempted.promise;
    controller.abort();
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(native.rename).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledTimes(1);
  });
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
