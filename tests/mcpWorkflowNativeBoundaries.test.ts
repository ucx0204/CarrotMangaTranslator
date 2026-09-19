import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";

it("cancels an admitted native selection save and waits for its page ownership to release", async () => {
  const f = await workflowFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = vi.fn();
  f.editing.assertWritable.mockImplementation(async () => {
    entered();
    await gate;
  });
  try {
    const before = await readFile(f.chapterPath);
    const plan = await f.prepare();
    const run = await f.run(plan.id);
    await vi.waitFor(() => expect(entered).toHaveBeenCalled(), { timeout: 10000 });
    expect((await f.get(plan.id)).status).toBe("running");
    expect(await f.invoke("carrot_run_workflow", run.input)).toMatchObject({ status: "running" });
    await expect(f.run(plan.id)).rejects.toThrow("already running");
    for (const name of ["carrot_get_workflow", "carrot_cancel_workflow"])
      await expect(f.invoke(name, { id: plan.id }, f.auth("foreign"))).rejects.toThrow("not owned");
    expect(await f.invoke("carrot_cancel_workflow", { id: plan.id })).toMatchObject({
      status: "running", cancellationRequested: true,
    });
    expect(await readFile(f.chapterPath)).toEqual(before);
    release();
    expect((await f.done(plan.id)).status).toBe("cancelled");
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.render).not.toHaveBeenCalled();
    const wait = f.current().selection.waitForEdit;
    if (!wait) throw new Error("Missing native batch completion boundary");
    await expect(wait("foreign", randomUUID(), randomUUID(), new AbortController().signal)).rejects.toThrow();
  } finally {
    release();
    await f.close();
  }
});

it("keeps the established cleanup barrier authoritative before another native model stage", async () => {
  const f = await workflowFixture();
  const barrier = await import("../src/main/runtimeSupport/modelCleanupBarrier");
  const resource = {};
  try {
    await expect(barrier.releaseModelResource(resource, async () => {
      throw new Error("Synthetic model cleanup failure");
    })).rejects.toThrow();
    const plan = await f.prepare();
    await f.run(plan.id);
    expect((await f.done(plan.id)).status).toBe("failed");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    await barrier.releaseModelResource(resource, async () => {});
    await f.run(plan.id, true);
    expect((await f.done(plan.id)).status, JSON.stringify(f.errors)).toBe("completed");
  } finally {
    await barrier.releaseModelResource(resource, async () => {});
    await f.close();
  }
});

it("binds internal completion leases to their existing owner and never reruns a completed job", async () => {
  const f = await workflowFixture();
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    await f.run(plan.id);
    const done = await f.done(plan.id);
    const jobId = done.steps[0].jobId;
    if (!jobId) throw new Error("Missing completed native job");
    await expect(f.current().operations.waitForCompletion(jobId, "foreign", new AbortController().signal)).rejects.toThrow();
    const state = await f.current().operations.waitForCompletion(jobId, f.owner, AbortSignal.abort());
    expect(state.status).toBe("completed");
    expect(f.render).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});
