import { expect, it, vi } from "vitest";
import { compositeNativeCallsFixture } from "./mcpCompositeNativeCalls.fixture";
import { deferred } from "./mcpCompositeWorkflow.fixture";

it("keeps the actual native job completion lease through a failed parent receipt checkpoint", async () => {
  const f = compositeNativeCallsFixture();
  const checkpointed = deferred();
  const original = new Error("encrypted checkpoint failed");
  let settled = false;
  try {
    const running = f.calls
      .execute(
        f.binding,
        new AbortController().signal,
        async () => {
          checkpointed.resolve();
          throw original;
        },
        () => {},
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    await checkpointed.promise;
    await f.cancelled.promise;
    expect(settled).toBe(false);
    f.release.resolve();
    expect(await running).toBe(original);
    expect(f.executionSignal()?.aborted).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await f.calls.findJob(f.binding)).toMatchObject({
      status: "cancelled",
    });
  } finally {
    await f.close();
  }
});

it("cancels and drains its admitted exact job when the returned child ID is wrong", async () => {
  const f = compositeNativeCallsFixture({ wrongReceipt: true });
  const checkpoint = vi.fn(async () => {});
  let settled = false;
  try {
    const running = f.calls
      .execute(f.binding, new AbortController().signal, checkpoint, () => {})
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    await f.entered.promise;
    await f.cancelled.promise;
    expect(settled).toBe(false);
    f.release.resolve();
    expect(await running).toMatchObject({ code: "invalid_edit" });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("looks up the exact completed owned journal entry without another native admission", async () => {
  const f = compositeNativeCallsFixture();
  try {
    f.release.resolve();
    const result = await f.calls.execute(
      f.binding,
      new AbortController().signal,
      async () => {},
      () => {},
    );
    expect(result.status).toBe("completed");
    expect(
      await f.calls.reconcile(f.binding, result.receipt, () => {}),
    ).toMatchObject({ receipt: result.receipt, status: "completed" });
    expect(
      await f.calls.reconcile(
        { ...f.binding, owner: "another-owner" },
        result.receipt,
        () => {},
      ),
    ).toBeNull();
    expect(f.execute).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
