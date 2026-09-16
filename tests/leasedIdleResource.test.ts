import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeasedIdleResourcePool } from "../src/main/runtimeSupport/leasedIdleResource";

type TestResource = { id: string; healthy: boolean };
const IDLE_TTL_MS = 1_000;
function createPool() {
  const disposed: Array<{ resource: TestResource; reason: string }> = [];
  const pool = new LeasedIdleResourcePool<TestResource>({
    idleTtlMs: IDLE_TTL_MS,
    isReusable: (resource) => resource.healthy,
    dispose: async (resource, reason) => {
      disposed.push({ resource, reason });
    },
  });
  return { disposed, pool };
}
async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("LeasedIdleResourcePool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("starts the idle timer only after the final same-key lease releases", async () => {
    const { disposed, pool } = createPool();
    const resource = { id: "shared", healthy: true };
    const create = vi.fn(async () => resource);
    const first = await pool.acquire("same-key", create);
    const second = await pool.acquire("same-key", create);
    expect(create).toHaveBeenCalledTimes(1);
    expect(second.reused).toBe(true);
    first.release();
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS);
    expect(disposed).toEqual([]);
    second.release();
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS - 1);
    expect(disposed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(disposed).toEqual([{ resource, reason: "idle-ttl" }]);
  });
  it("keeps an active replaced resource alive and isolates stale releases", async () => {
    const { disposed, pool } = createPool();
    const oldResource = { id: "old", healthy: true };
    const newResource = { id: "new", healthy: true };
    const oldLease = await pool.acquire("old-key", async () => oldResource);
    const createNew = vi.fn(async () => newResource);
    const newAcquisition = pool.acquire("new-key", createNew);
    await flushPromises();
    expect(disposed).toEqual([]);
    expect(createNew).not.toHaveBeenCalled();
    oldLease.release();
    const newLease = await newAcquisition;
    expect(disposed).toEqual([{ resource: oldResource, reason: "replace" }]);
    expect(createNew).toHaveBeenCalledTimes(1);
    oldLease.release();
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS);
    expect(disposed).toEqual([{ resource: oldResource, reason: "replace" }]);
    expect(newLease.resource).toBe(newResource);
    newLease.release();
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS);
    expect(disposed).toEqual([
      { resource: oldResource, reason: "replace" },
      { resource: newResource, reason: "idle-ttl" },
    ]);
  });
  it("defers an explicit dispose request until every active lease releases", async () => {
    const { disposed, pool } = createPool();
    const resource = { id: "active", healthy: true };
    const first = await pool.acquire("active-key", async () => resource);
    const second = await pool.acquire("active-key", async () => resource);
    let settled = false;
    const disposal = pool.dispose("explicit").then((result) => {
      settled = true;
      return result;
    });
    await flushPromises();
    expect(settled).toBe(false);
    first.release();
    await flushPromises();
    expect(settled).toBe(false);
    expect(disposed).toEqual([]);
    second.release();
    await expect(disposal).resolves.toBe(true);
    expect(disposed).toEqual([{ resource, reason: "explicit" }]);
  });
  it("does not poison later acquisitions when resource creation fails", async () => {
    const { pool } = createPool();
    const failure = new Error("runtime preparation failed");
    await expect(
      pool.acquire("broken", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const resource = { id: "recovered", healthy: true };
    const lease = await pool.acquire("working", async () => resource);
    expect(lease.resource).toBe(resource);
    lease.release();
    await pool.dispose("test-finished");
  });
  it.each(["explicit", "idle-ttl", "replace"])(
    "retains failed %s cleanup and blocks replacement until explicit recovery",
    async (mode) => {
      const failure = new Error("worker shutdown not acknowledged");
      let fail = true;
      const dispose = vi.fn(async () => {
        if (fail) throw failure;
      });
      const pool = new LeasedIdleResourcePool<TestResource>({
        idleTtlMs: IDLE_TTL_MS,
        isReusable: () => true,
        dispose,
      });
      const first = await pool.acquire("first", async () => ({
        id: "first",
        healthy: true,
      }));
      first.release();
      const create = vi.fn(async () => ({ id: "second", healthy: true }));
      if (mode === "idle-ttl") await vi.advanceTimersByTimeAsync(IDLE_TTL_MS);
      else if (mode === "explicit")
        await expect(pool.dispose("explicit")).rejects.toBe(failure);
      else await expect(pool.acquire("second", create)).rejects.toBe(failure);
      await expect(pool.acquire("second", create)).rejects.toBe(failure);
      await expect(pool.acquire("first", create)).rejects.toBe(failure);
      expect(create).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
      fail = false;
      await expect(pool.dispose("retry-cleanup")).resolves.toBe(true);
      const second = await pool.acquire("second", create);
      first.release();
      expect(second.resource.id).toBe("second");
      expect(create).toHaveBeenCalledTimes(1);
      second.release();
      await pool.dispose("test-finished");
      await expect(pool.dispose("empty")).resolves.toBe(false);
    },
  );
  it("does not create a replacement while the previous disposer is still running", async () => {
    let finish!: () => void;
    const dispose = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pool = new LeasedIdleResourcePool<TestResource>({
      idleTtlMs: IDLE_TTL_MS,
      isReusable: () => true,
      dispose,
    });
    const first = await pool.acquire("a", async () => ({
      id: "a",
      healthy: true,
    }));
    first.release();
    const create = vi.fn(async () => ({ id: "b", healthy: true }));
    const pending = pool.acquire("b", create);
    await flushPromises();
    expect(dispose).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    finish();
    const second = await pending;
    expect(create).toHaveBeenCalledOnce();
    dispose.mockImplementation(async () => {});
    second.release();
    await pool.dispose("test-finished");
  });
});
