import { describe, expect, it, vi } from "vitest";
import { createJobLifetimeCleanupBoundary } from "../src/main/jobs/jobLifetimeCleanup";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

describe("createJobLifetimeCleanupBoundary", () => {
  it("waits for late resource cleanup when cancellation comes first", async () => {
    const lifetime = createJobLifetimeCleanupBoundary();
    const resourceGate = createDeferred<void>();
    const resourceCleanup = vi.fn(() => resourceGate.promise);

    const cleanupPromise = lifetime.cleanup();
    await expectPending(cleanupPromise);

    lifetime.registerResourceCleanup(resourceCleanup);
    await Promise.resolve();
    expect(resourceCleanup).toHaveBeenCalledTimes(1);
    await expectPending(cleanupPromise);

    lifetime.finish();
    await expectPending(cleanupPromise);
    resourceGate.resolve(undefined);
    await expect(cleanupPromise).resolves.toBeUndefined();
  });

  it("starts an already-registered resource immediately on cleanup request", async () => {
    const lifetime = createJobLifetimeCleanupBoundary();
    const resourceCleanup = vi.fn(async () => undefined);
    lifetime.registerResourceCleanup(resourceCleanup);

    const cleanupPromise = lifetime.cleanup();
    await Promise.resolve();
    expect(resourceCleanup).toHaveBeenCalledTimes(1);
    await expectPending(cleanupPromise);

    lifetime.finish();
    await expect(cleanupPromise).resolves.toBeUndefined();
  });

  it("waits only for job completion when no resource was created", async () => {
    const lifetime = createJobLifetimeCleanupBoundary();
    const cleanupPromise = lifetime.cleanup();
    await expectPending(cleanupPromise);
    lifetime.finish();
    await expect(cleanupPromise).resolves.toBeUndefined();
  });

  it("does not run registered resources on normal finish or on cleanup after finish", async () => {
    const lifetime = createJobLifetimeCleanupBoundary();
    const resourceCleanup = vi.fn(async () => undefined);
    lifetime.registerResourceCleanup(resourceCleanup);

    lifetime.finish();
    expect(resourceCleanup).not.toHaveBeenCalled();
    await expect(lifetime.cleanup()).resolves.toBeUndefined();
    expect(resourceCleanup).not.toHaveBeenCalled();
  });

  it("runs each resource once across duplicate cleanup callers", async () => {
    const lifetime = createJobLifetimeCleanupBoundary();
    const resourceGate = createDeferred<void>();
    const resourceCleanup = vi.fn(() => resourceGate.promise);
    lifetime.registerResourceCleanup(resourceCleanup);

    const first = lifetime.cleanup();
    const second = lifetime.cleanup();
    await Promise.resolve();
    expect(resourceCleanup).toHaveBeenCalledTimes(1);

    lifetime.finish();
    resourceGate.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(resourceCleanup).toHaveBeenCalledTimes(1);
  });

  it("waits for every resource registered after cleanup was requested", async () => {
    const lifetime = createJobLifetimeCleanupBoundary();
    const firstGate = createDeferred<void>();
    const secondGate = createDeferred<void>();
    const firstCleanup = vi.fn(() => firstGate.promise);
    const secondCleanup = vi.fn(() => secondGate.promise);

    const cleanupPromise = lifetime.cleanup();
    lifetime.registerResourceCleanup(firstCleanup);
    lifetime.registerResourceCleanup(secondCleanup);
    await Promise.resolve();
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(secondCleanup).toHaveBeenCalledTimes(1);

    lifetime.finish();
    firstGate.resolve(undefined);
    await expectPending(cleanupPromise);
    secondGate.resolve(undefined);
    await expect(cleanupPromise).resolves.toBeUndefined();
  });

  it("captures cleanup rejection immediately and reports it after finish", async () => {
    const lifetime = createJobLifetimeCleanupBoundary();
    const failure = new Error("dispose failed");
    lifetime.registerResourceCleanup(async () => {
      throw failure;
    });

    const cleanupPromise = lifetime.cleanup();
    await Promise.resolve();
    await Promise.resolve();
    await expectPending(cleanupPromise);
    lifetime.finish();
    await expect(cleanupPromise).rejects.toBe(failure);
  });

  it("aggregates multiple cleanup failures", async () => {
    const lifetime = createJobLifetimeCleanupBoundary();
    const first = new Error("first");
    const second = new Error("second");
    lifetime.registerResourceCleanup(async () => {
      throw first;
    });
    lifetime.registerResourceCleanup(async () => {
      throw second;
    });

    const cleanupPromise = lifetime.cleanup();
    lifetime.finish();
    await expect(cleanupPromise).rejects.toMatchObject({
      name: "AggregateError",
      errors: [first, second],
    });
  });

  it("makes finish idempotent and rejects registration after completion", async () => {
    const lifetime = createJobLifetimeCleanupBoundary();
    lifetime.finish();
    lifetime.finish();
    await expect(lifetime.cleanup()).resolves.toBeUndefined();
    expect(() =>
      lifetime.registerResourceCleanup(async () => undefined),
    ).toThrow("Cannot register a resource cleanup after job completion.");
  });
});
