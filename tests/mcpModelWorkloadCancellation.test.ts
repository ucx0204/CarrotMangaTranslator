import { expect, it, vi } from "vitest";
import {
  acquireModelWorkload,
  withModelWorkload,
} from "../src/main/runtimeSupport/modelWorkload";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("rejects an already aborted child before acquiring a grouped resource", async () => {
  const create = vi.fn(async () => ({ value: {}, release: async () => {} }));
  await expect(withModelWorkload("translation", new AbortController().signal, async () => {
    const lease = await acquireModelWorkload("translation", "fixed", AbortSignal.abort(), create);
    await lease.release();
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(create).not.toHaveBeenCalled();
});

it("propagates only the current child's cancellation during resource creation and still disposes the acquired resource", async () => {
  const child = new AbortController();
  const started = deferred(), finish = deferred();
  const dispose = vi.fn(async () => {});
  let resourceSignal: AbortSignal | undefined;
  const run = withModelWorkload("translation", new AbortController().signal, async () => {
    const lease = await acquireModelWorkload("translation", "fixed", child.signal, async (signal) => {
      resourceSignal = signal;
      started.resolve();
      await finish.promise;
      return { value: {}, release: dispose };
    });
    await lease.release();
  }).then(() => ({ error: undefined }), (error: unknown) => ({ error }));
  try {
    await started.promise;
    child.abort();
    expect(resourceSignal?.aborted).toBe(true);
  } finally { finish.resolve(); await run; }
  expect((await run).error).toMatchObject({ name: "AbortError" });
  expect(dispose).toHaveBeenCalledTimes(1);
});

it("detaches a returned child's abort handler without affecting a later borrower", async () => {
  const first = new AbortController(), second = new AbortController();
  const dispose = vi.fn(async () => {});
  let resourceSignal: AbortSignal | undefined;
  const create = vi.fn(async (signal: AbortSignal | undefined) => {
    resourceSignal = signal;
    return { value: {}, release: dispose };
  });
  await withModelWorkload("inpainting", new AbortController().signal, async () => {
    const a = await acquireModelWorkload("inpainting", "fixed", first.signal, create);
    await a.release();
    const b = await acquireModelWorkload("inpainting", "fixed", second.signal, create);
    try {
      first.abort();
      await a.release();
      expect(resourceSignal?.aborted).toBe(false);
      expect(b.value).toBe(a.value);
      second.abort();
      expect(resourceSignal?.aborted).toBe(true);
    } finally { await b.release(); }
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
});

it("preserves the original ungrouped lease and caller signal", async () => {
  const child = new AbortController();
  const release = vi.fn(async () => {});
  const native = { value: {}, release };
  const create = vi.fn(async () => native);
  expect(await acquireModelWorkload("translation", "standalone", child.signal, create)).toBe(native);
  expect(create).toHaveBeenCalledWith(child.signal);
  expect(release).not.toHaveBeenCalled();
  await native.release();
});
