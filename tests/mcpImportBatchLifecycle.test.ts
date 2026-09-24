import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { importBatchFixture } from "./mcpImportBatch.fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("pauses only after the active URL cleans up and resumes remaining sources without repeating the first", async () => {
  const f = await importBatchFixture();
  const entered = deferred(),
    release = deferred();
  try {
    const original = f.web.scan.getMockImplementation();
    if (!original) throw new Error("Missing browser boundary");
    f.web.scan.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const plan = await f.prepareBatch();
    const accepted = await f.invoke(
      "carrot_run_import_batch",
      await f.batchCommand(plan.id),
    );
    await entered.promise;
    const pause = await f.invoke("carrot_pause_import_batch", { id: plan.id });
    expect(pause).toMatchObject({ status: "running", pauseRequested: true });
    expect(f.web.scan).toHaveBeenCalledOnce();
    release.resolve();
    expect(await f.settle(accepted)).toMatchObject({ status: "completed" });
    expect((await f.get(plan.id)).items.map((item) => item.status)).toEqual([
      "ready",
      "pending",
      "pending",
    ]);
    expect(await f.get(plan.id)).toMatchObject({ status: "paused" });
    expect((await f.run(plan.id)).view.status).toBe("review_required");
    expect(f.web.scan.mock.calls.map(([request]) => request.url)).toEqual(
      plan.items.map((item) => item.url),
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

it("cancels the native job, waits for browser cleanup, refuses active disposal and retries only after explicit selection", async () => {
  const f = await importBatchFixture(2);
  const entered = deferred(),
    cleaning = deferred(),
    release = deferred();
  try {
    f.web.scan.mockImplementationOnce(async (_request, signal) => {
      entered.resolve();
      try {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      } finally {
        cleaning.resolve();
        await release.promise;
      }
      throw new Error("Unreachable browser boundary");
    });
    const plan = await f.prepareBatch();
    const accepted = await f.invoke(
      "carrot_run_import_batch",
      await f.batchCommand(plan.id),
    );
    await entered.promise;
    await expect(
      f.invoke("carrot_cancel_import_batch", { id: plan.id }, f.auth("other")),
    ).rejects.toThrow();
    const cancel = f.invoke("carrot_cancel_import_batch", { id: plan.id });
    await cleaning.promise;
    expect(await cancel).toMatchObject({
      status: "running",
      cancellationRequested: true,
    });
    await expect(
      f.invoke("carrot_discard_import_batch", { id: plan.id, confirm: true }),
    ).rejects.toThrow();
    expect(f.web.scan).toHaveBeenCalledOnce();
    release.resolve();
    expect(await f.settle(accepted)).toMatchObject({ status: "cancelled" });
    const stopped = await f.get(plan.id);
    expect(stopped).toMatchObject({ status: "cancelled" });
    expect(stopped.items.map((item) => item.status)).toEqual([
      "cancelled",
      "pending",
    ]);
    const resumed = await f.run(plan.id);
    expect(resumed.view.items.map((item) => item.status)).toEqual([
      "cancelled",
      "ready",
    ]);
    expect(f.web.scan).toHaveBeenCalledTimes(2);
    expect(
      (await f.run(plan.id, { retryItemIds: [plan.items[0].id] })).view.status,
    ).toBe("review_required");
    expect(f.web.scan).toHaveBeenCalledTimes(3);
  } finally {
    release.resolve();
    await f.close();
  }
});

it("does not spend another attempt when the fixed total budget is exhausted", async () => {
  const f = await importBatchFixture(1);
  try {
    f.web.scan.mockRejectedValueOnce(new Error("Synthetic unavailable page"));
    const plan = await f.prepareBatch({ ...f.input, maxAttempts: 1 });
    await f.run(plan.id);
    const retry = await f.run(plan.id, { retryItemIds: [plan.items[0].id] });
    expect(retry.done).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(retry.view).toMatchObject({ status: "failed", attemptCount: 1 });
    expect(f.web.scan).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("never advertises final completion before the encrypted final checkpoint finishes", async () => {
  const f = await importBatchFixture(1);
  const entered = deferred(),
    release = deferred();
  const original = f.codec.seal.bind(f.codec);
  f.codec.seal = async (value) => {
    if (
      value &&
      typeof value === "object" &&
      "status" in value &&
      value.status === "review_required"
    ) {
      entered.resolve();
      await release.promise;
    }
    return original(value);
  };
  try {
    const plan = await f.prepareBatch();
    const accepted = await f.invoke(
      "carrot_run_import_batch",
      await f.batchCommand(plan.id),
    );
    await entered.promise;
    // This getter may wait for a library read lock; observe the existing app job as well.
    const jobs = f.current().operations.list("import-owner", 0, 25);
    expect(jobs.jobs[0].status).toBe("running");
    await expect(
      f.invoke("carrot_discard_import_batch", { id: plan.id, confirm: true }),
    ).rejects.toThrow();
    release.resolve();
    expect(await f.settle(accepted)).toMatchObject({ status: "completed" });
    expect((await f.get(plan.id)).status).toBe("review_required");
    expect(f.web.scan).toHaveBeenCalledOnce();
    const unchanged = await f.invoke("carrot_pause_import_batch", {
      id: plan.id,
    });
    expect(unchanged).toMatchObject({
      status: "review_required",
      pauseRequested: false,
    });
    expect(
      await f.invoke("carrot_cancel_import_batch", { id: plan.id }),
    ).toMatchObject({ status: "review_required" });
    await expect(
      f.invoke("carrot_run_import_batch", {
        ...(await f.batchCommand(plan.id)),
        retryItemIds: [randomUUID(), randomUUID()],
        path: "C:/private",
      }),
    ).rejects.toThrow();
  } finally {
    release.resolve();
    await f.close();
  }
});
