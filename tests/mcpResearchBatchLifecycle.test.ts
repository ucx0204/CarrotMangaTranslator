import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { researchBatchFixture } from "./mcpResearchBatch.fixture";
import { hashStableValue } from "../src/shared/blockFingerprint";
import { McpResearchBatchRunSchema } from "../src/shared/mcpResearchBatch";

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

it("pauses after the admitted child settles and explicitly resumes only remaining works", async () => {
  const f = await researchBatchFixture();
  const gate = latch();
  try {
    const native = f.research.getMockImplementation();
    if (!native) throw new Error("Missing provider boundary");
    f.research.mockImplementationOnce(async (...args) => {
      await gate.promise;
      return native(...args);
    });
    const plan = await f.prepare();
    await f.run(plan.id);
    await vi.waitFor(() => expect(f.research).toHaveBeenCalledOnce());
    await expect(
      f.invoke("carrot_pause_research_batch", { id: plan.id }, f.auth("other")),
    ).rejects.toThrow();
    expect(
      await f.invoke("carrot_pause_research_batch", { id: plan.id }),
    ).toMatchObject({ status: "running", pauseRequested: true });
    await expect(f.run(plan.id)).rejects.toThrow("running");
    await expect(
      f.invoke("carrot_discard_research_batch", { id: plan.id, confirm: true }),
    ).rejects.toThrow();
    gate.release();
    const paused = await f.settle(plan.id);
    expect(paused.status).toBe("paused");
    expect(paused.works.map((work) => work.status)).toEqual([
      "proposed",
      "pending",
      "pending",
    ]);
    await f.restartBatch();
    await f.run(plan.id);
    expect((await f.settle(plan.id)).status).toBe("completed");
    expect(f.research).toHaveBeenCalledTimes(3);
  } finally {
    gate.release();
    await f.close();
  }
});

it("keeps cancellation running until the admitted provider cleanup finishes and does not start the next work", async () => {
  const f = await researchBatchFixture();
  const cleanup = latch();
  let aborted = false;
  try {
    f.research.mockImplementationOnce(async (_request, signal) => {
      if (!signal) throw new Error("Missing native signal");
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
        if (signal.aborted) {
          aborted = true;
          resolve();
        }
      });
      await cleanup.promise;
      signal.throwIfAborted();
      throw new Error("Cancellation test must not succeed");
    });
    const plan = await f.prepare();
    await f.run(plan.id);
    await vi.waitFor(() => expect(f.research).toHaveBeenCalledOnce());
    await f.invoke("carrot_cancel_research_batch", { id: plan.id });
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(await f.get(plan.id)).toMatchObject({
      status: "running",
      cancellationRequested: true,
    });
    expect(f.research).toHaveBeenCalledOnce();
    await expect(f.run(plan.id, true)).rejects.toThrow();
    cleanup.release();
    const result = await f.settle(plan.id);
    expect(result.status).toBe("cancelled");
    expect(result.works[0].attempts[0].usage).toBeNull();
    expect(
      result.works.slice(1).every((work) => work.status === "pending"),
    ).toBe(true);
    expect(f.app.jobs.gate.activities).toEqual([]);
    await f.run(plan.id);
    const remaining = await f.settle(plan.id);
    expect(remaining.status).toBe("partial");
    expect(f.research).toHaveBeenCalledTimes(3);
  } finally {
    cleanup.release();
    await f.close();
  }
});

it("does not report completion or allow another run while the final encrypted checkpoint is blocked", async () => {
  const f = await researchBatchFixture(1);
  const gate = latch();
  const seal = f.codec.seal;
  let blocked = false;
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    if (
      value &&
      typeof value === "object" &&
      "status" in value &&
      value.status === "completed" &&
      "works" in value
    ) {
      blocked = true;
      await gate.promise;
    }
    return seal(value);
  });
  let completionCleanup: Promise<unknown> | undefined;
  try {
    const plan = await f.prepare();
    const command = McpResearchBatchRunSchema.parse({
      id: plan.id,
      version: plan.version,
      requestId: randomUUID(),
      allowExternal: true,
      allowAssetDownloads: true,
    });
    const reference = {
      id: command.id,
      requestId: command.requestId,
      fingerprint: hashStableValue(["run", command]),
    };
    await f.invoke("carrot_run_research_batch", command);
    await vi.waitFor(() => expect(blocked).toBe(true), { timeout: 10000 });
    expect((await f.get(plan.id)).status).toBe("running");
    const completion = f.current().batch.completion;
    expect(await completion.find("migration-owner", reference)).toMatchObject({
      status: "running",
    });
    let settled = false;
    const waiting = completion
      .wait("migration-owner", command, new AbortController().signal)
      .then((result) => {
        settled = true;
        return result;
      });
    completionCleanup = Promise.allSettled([waiting]);
    await expect(f.run(plan.id)).rejects.toThrow();
    expect(settled).toBe(false);
    gate.release();
    const completed = await waiting;
    expect(completed.status).toBe("completed");
    expect(await f.settle(plan.id)).toEqual(completed);
    await f.restartBatch();
    expect(
      await f.current().batch.completion.find("migration-owner", reference),
    ).toEqual(completed);
    await expect(
      f.current().batch.completion.find("other", reference),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.research).toHaveBeenCalledOnce();
  } finally {
    gate.release();
    hook.mockRestore();
    await completionCleanup;
    await f.close();
  }
});

it("does not exceed the fixed total attempt budget or erase earlier completed reviews", async () => {
  const f = await researchBatchFixture();
  try {
    const input = await f.input();
    input.maxAttempts = 2;
    const plan = await f.prepare(input);
    await f.run(plan.id);
    const result = await f.settle(plan.id);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "invalid_edit",
      attemptsUsed: 2,
    });
    expect(result.works.map((work) => work.status)).toEqual([
      "proposed",
      "proposed",
      "pending",
    ]);
    await f.run(plan.id, true);
    expect((await f.settle(plan.id)).attemptsUsed).toBe(2);
    expect(f.research).toHaveBeenCalledTimes(2);
    await expect(
      f.invoke("carrot_run_research_batch", {
        id: plan.id,
        version: result.version,
        requestId: randomUUID(),
        allowExternal: true,
        maxAttempts: 30,
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
