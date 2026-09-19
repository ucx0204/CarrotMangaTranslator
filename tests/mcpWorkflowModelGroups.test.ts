import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import {
  withModelWorkload,
  acquireModelWorkload,
} from "../src/main/runtimeSupport/modelWorkload";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("uses one endpoint for sequential workflow pages and disposes before rendering", async () => {
  const f = await workflowFixture();
  try {
    f.render.mockImplementation(async (page) => {
      expect(f.dispose).toHaveBeenCalledTimes(1);
      const { readFile } = await import("node:fs/promises");
      return readFile(page.imagePath);
    });
    const plan = await f.prepare();
    await f.run(plan.id);
    const done = await f.done(plan.id);
    expect(done.status, JSON.stringify(f.errors)).toBe("completed");
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(4);
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.render).toHaveBeenCalledTimes(2);
    expect(f.app.jobs.all).toEqual([]);
  } finally {
    await f.close();
  }
});

it("keeps workflow status and native exclusion active until physical group cleanup settles", async () => {
  const f = await workflowFixture();
  const disposing = deferred(),
    finish = deferred();
  f.dispose.mockImplementation(async () => {
    disposing.resolve();
    await finish.promise;
  });
  try {
    const plan = await f.prepare();
    await f.run(plan.id);
    await disposing.promise;
    expect((await f.get(plan.id)).status).toBe("running");
    expect(f.app.jobs.hasActive).toBe(true);
    expect(f.render).not.toHaveBeenCalled();
    expect(() =>
      f.app.jobs.start({
        id: "foreign-model",
        kind: "gemma-analysis",
        abortController: new AbortController(),
        resources: [{ kind: "model-runtime", scope: "*", access: "write" }],
      }),
    ).toThrow();
    finish.resolve();
    expect((await f.done(plan.id)).status).toBe("completed");
    expect(f.start).toHaveBeenCalledTimes(1);
  } finally {
    finish.resolve();
    f.app.jobs.clearIfCurrent("foreign-model");
    await f.close();
  }
});

it("does not start the following stage when group disposal fails", async () => {
  const f = await workflowFixture();
  try {
    f.dispose.mockRejectedValueOnce(
      new Error("external endpoint cleanup failed"),
    );
    const plan = await f.prepare();
    await f.run(plan.id);
    expect((await f.done(plan.id)).status).toBe("failed");
    expect(f.render).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(4);
    expect(f.app.jobs.all).toEqual([]);
  } finally {
    await f.close();
  }
});

it("preserves native model exclusion between children while keeping child identities separate", async () => {
  const jobs = new ActiveJobStore();
  const entered = deferred(),
    finish = deferred();
  const controller = new AbortController();
  const run = jobs.runModelGroup(controller, async () => {
    for (const id of ["one", "two"]) {
      jobs.start({
        id,
        kind: "gemma-analysis",
        abortController: new AbortController(),
        resources: [{ kind: "model-runtime", scope: "*", access: "write" }],
      });
      expect(jobs.activityOwnerFor(id)).not.toBe(id);
      expect(jobs.get(id)?.id).toBe(id);
      expect(() =>
        jobs.start({
          id: "overlap",
          kind: "gemma-analysis",
          abortController: new AbortController(),
          resources: [],
        }),
      ).toThrow("sequentially");
      jobs.clearIfCurrent(id);
    }
    entered.resolve();
    await finish.promise;
  });
  try {
    await entered.promise;
    expect(jobs.all).toHaveLength(1);
    expect(() =>
      jobs.start({
        id: "outside",
        kind: "gemma-analysis",
        abortController: new AbortController(),
        resources: [{ kind: "model-runtime", scope: "*", access: "write" }],
      }),
    ).toThrow();
  } finally {
    finish.resolve();
    await run;
  }
  expect(jobs.all).toEqual([]);
});

it("binds duplicate child releases to their own borrow and never releases a later borrower", async () => {
  const dispose = vi.fn(async () => {});
  const create = vi.fn(async () => ({
    value: { model: "native" },
    release: dispose,
  }));
  await withModelWorkload(
    "inpainting",
    new AbortController().signal,
    async () => {
      const first = await acquireModelWorkload(
        "inpainting",
        "fixed",
        undefined,
        create,
      );
      await expect(
        acquireModelWorkload("inpainting", "fixed", undefined, create),
      ).rejects.toThrow("borrower");
      await first.release();
      const second = await acquireModelWorkload(
        "inpainting",
        "fixed",
        undefined,
        create,
      );
      expect(second.value).toBe(first.value);
      await first.release();
      await expect(
        acquireModelWorkload("inpainting", "fixed", undefined, create),
      ).rejects.toThrow("borrower");
      await second.release();
      await expect(
        acquireModelWorkload("inpainting", "different", undefined, create),
      ).rejects.toThrow("configuration");
      expect(dispose).not.toHaveBeenCalled();
    },
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
});

it("preserves work and cleanup errors and disposes resources acquired during cancellation", async () => {
  const gate = deferred(),
    started = deferred();
  const controller = new AbortController();
  const disposal = vi.fn(async () => {});
  const running = withModelWorkload(
    "translation",
    controller.signal,
    async () => {
      await acquireModelWorkload(
        "translation",
        "fixed",
        controller.signal,
        async () => {
          started.resolve();
          await gate.promise;
          return { value: {}, release: disposal };
        },
      );
    },
  );
  const checked = expect(running).rejects.toThrow();
  await started.promise;
  controller.abort();
  gate.resolve();
  await checked;
  expect(disposal).toHaveBeenCalledTimes(1);
  await expect(
    withModelWorkload("translation", new AbortController().signal, async () => {
      const borrowed = await acquireModelWorkload(
        "translation",
        "fixed",
        undefined,
        async () => ({
          value: {},
          release: async () => {
            throw new Error("cleanup");
          },
        }),
      );
      await borrowed.release();
      throw new Error("work");
    }),
  ).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: "work" }),
      expect.objectContaining({ message: "cleanup" }),
    ],
  });
});

it("awaits native group cleanup and refuses escaped ownership after group completion", async () => {
  const diagnostics = { info: vi.fn(), error: vi.fn() };
  const jobs = new ActiveJobStore(diagnostics);
  const entered = deferred(),
    finish = deferred();
  const controller = new AbortController();
  let late: (() => void) | undefined;
  const run = jobs.runModelGroup(controller, async () => {
    await expect(
      jobs.runModelGroup(new AbortController(), async () => {}),
    ).rejects.toThrow("Nested");
    late = AsyncLocalStorage.bind(() =>
      jobs.start({
        id: "late-child",
        kind: "gemma-analysis",
        abortController: new AbortController(),
        resources: [],
      }),
    );
    entered.resolve();
    await finish.promise;
    expect(() =>
      jobs.start({
        id: "cancelled-child",
        kind: "gemma-analysis",
        abortController: new AbortController(),
        resources: [],
      }),
    ).toThrow();
  });
  await entered.promise;
  const parent = jobs.all[0];
  if (!parent) throw new Error("Missing native workload parent");
  controller.abort();
  let settled = false;
  const cleanup = jobs
    .runCleanup(parent, "isolated group shutdown")
    .then(() => {
      settled = true;
    });
  try {
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(jobs.hasActive).toBe(true);
  } finally {
    finish.resolve();
    await run;
    await cleanup;
  }
  expect(settled).toBe(true);
  expect(diagnostics.info).toHaveBeenCalledTimes(1);
  expect(diagnostics.error).not.toHaveBeenCalled();
  expect(jobs.all).toEqual([]);
  if (!late) throw new Error("Missing escaped callback");
  expect(late).toThrow("no longer active");
});
