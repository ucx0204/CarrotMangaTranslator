import { afterEach, expect, it, vi } from "vitest";
import { withFontChapterC18Worker } from "../src/main/pipeline/fontChapterC18Lifecycle";
import {
  assertModelCleanupComplete,
  modelCleanupIsBlocked,
  releaseModelResource,
} from "../src/main/runtimeSupport/modelCleanupBarrier";

const workers: { dispose: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0))
    await releaseModelResource(worker, async () => {});
  expect(modelCleanupIsBlocked()).toBe(false);
});

it("holds completion until cleanup resolves and fences other local model admissions", async () => {
  let finish!: () => void;
  const disposing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const worker = { dispose: vi.fn(() => disposing) };
  workers.push(worker);
  let settled = false;
  const task = withFontChapterC18Worker(worker, async () => "choices").then(
    (result) => {
      settled = true;
      return result;
    },
  );
  await vi.waitFor(() => expect(worker.dispose).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  expect(() => assertModelCleanupComplete()).toThrow();
  expect(() => assertModelCleanupComplete([])).not.toThrow();
  finish();
  expect(await task).toBe("choices");
  expect(modelCleanupIsBlocked()).toBe(false);
});

it("releases after a rejected analysis and retains its exact original error", async () => {
  const worker = { dispose: vi.fn(async () => {}) };
  const failure = new Error("invalid source inventory");
  await expect(
    withFontChapterC18Worker(worker, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(worker.dispose).toHaveBeenCalledOnce();
});

it("retains the cleanup fence when successful analysis cannot release its worker", async () => {
  const failure = new Error("worker would not exit");
  const worker = {
    dispose: vi.fn(async () => {
      throw failure;
    }),
  };
  workers.push(worker);
  await expect(
    withFontChapterC18Worker(worker, async () => "choices"),
  ).rejects.toMatchObject({ code: "MODEL_CLEANUP_INCOMPLETE", cause: failure });
  expect(modelCleanupIsBlocked()).toBe(true);
});

it("keeps both the primary failure and the worker cleanup failure", async () => {
  const primary = new Error("analysis cancelled");
  const cleanup = new Error("termination failed");
  const worker = {
    dispose: vi.fn(async () => {
      throw cleanup;
    }),
  };
  workers.push(worker);
  const task = withFontChapterC18Worker(worker, async () => {
    throw primary;
  });
  await expect(task).rejects.toMatchObject({
    errors: [primary, { code: "MODEL_CLEANUP_INCOMPLETE", cause: cleanup }],
  });
  expect(modelCleanupIsBlocked()).toBe(true);
});
