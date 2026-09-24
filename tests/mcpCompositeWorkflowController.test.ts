import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { McpCompositePrepareSchema } from "../src/shared/mcpCompositeWorkflow";
import { McpCompositeWorkflowActionSchema } from "../src/shared/mcpCompositeWorkflowActions";
import { McpCompositeWorkflowService } from "../src/main/application/mcpCompositeWorkflowService";
import {
  compositeFixture,
  compositePlan,
  deferred,
  guard,
  mutation,
  owner,
} from "./mcpCompositeWorkflow.fixture";

it("prepares bounded fixed phases without admitting native work and keeps raw native input session-only", async () => {
  const f = compositeFixture();
  const plan = compositePlan();
  const prepared = await f.service.prepare(owner, plan, guard);
  expect(f.events).toEqual([]);
  expect((await f.service.prepare(owner, plan, guard)).id).toBe(prepared.id);
  const bound = await f.bind(prepared);
  expect(bound.phases[0].binding).toMatchObject({
    family: "workflow-run",
    owner,
  });
  expect(bound.phases[0].binding).not.toHaveProperty("action");
  expect(JSON.stringify(f.records.get(bound.id))).not.toContain('"input":');
  expect(
    McpCompositeWorkflowActionSchema.safeParse({
      kind: "call-tool",
      input: { name: "anything" },
    }).success,
  ).toBe(false);
  expect(
    McpCompositePrepareSchema.safeParse({
      ...plan,
      phases: Array.from({ length: 33 }, (_, i) => ({
        kind: "review",
        id: `p${i}`,
      })),
    }).success,
  ).toBe(false);
  expect(
    McpCompositePrepareSchema.safeParse({ ...plan, maxReviewPasses: 4 })
      .success,
  ).toBe(false);
  expect(Object.values(plan.budgets.models)).toEqual([0, 0, 0, 0, 0, 0]);
});

it("commits native budget and exact attempt before admission and exact run replay never charges again", async () => {
  const cleanup = deferred();
  const f = compositeFixture({ cleanup });
  const bound = await f.bind(
    await f.service.prepare(owner, compositePlan(), guard),
  );
  const input = mutation(bound);
  const started = await f.service.run(owner, input, guard);
  await f.entered.promise;
  expect(started.used).toMatchObject({ admissions: 1, pageAttempts: 1 });
  expect(started.phases[0]).toMatchObject({
    status: "running",
    attemptId: expect.any(String),
  });
  expect((await f.service.run(owner, input, guard)).used.admissions).toBe(1);
  expect(f.events).toEqual(["admitted"]);
  cleanup.resolve();
  const settled = await f.service.waitForCompletion(owner, started.id, guard);
  expect(settled.status).toBe("completed");
  expect(settled.phases[0].outcome?.receipt).toEqual(settled.phases[0].child);
  expect(f.events).toEqual(["admitted", "physically-settled"]);
});

it("rejects server-resolved model costs above the zero default before a native start", async () => {
  const f = compositeFixture();
  f.cost.models.ocr = 1;
  const bound = await f.bind(
    await f.service.prepare(owner, compositePlan(), guard),
  );
  await expect(
    f.service.run(owner, mutation(bound), guard),
  ).rejects.toMatchObject({ code: "invalid_edit" });
  expect(f.events).toEqual([]);
  expect((await f.service.get(owner, bound.id, guard)).used.admissions).toBe(0);
});

it("waits for physical cleanup after checkpoint failure and retains an interrupted admission without retry", async () => {
  const cleanup = deferred();
  const f = compositeFixture({ failCheckpoint: true, cleanup });
  const bound = await f.bind(
    await f.service.prepare(owner, compositePlan(), guard),
  );
  await f.service.run(owner, mutation(bound), guard);
  await f.entered.promise;
  let finished = false;
  const waiting = f.service.waitForCompletion(owner, bound.id, guard);
  void waiting.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  await Promise.resolve();
  expect(finished).toBe(false);
  cleanup.resolve();
  await expect(waiting).rejects.toThrow("Checkpoint write failed");
  const held = await f.service.get(owner, bound.id, guard);
  expect(held).toMatchObject({
    status: "held",
    usageUnknown: true,
    used: { admissions: 1 },
  });
  await expect(f.bind(held)).rejects.toThrow();
  expect(f.events.filter((event) => event === "admitted")).toHaveLength(1);
});

it("cancellation still drains the native child when saving its control action fails authorization", async () => {
  const cleanup = deferred();
  const f = compositeFixture({ waitForAbort: true, cleanup });
  const bound = await f.bind(
    await f.service.prepare(owner, compositePlan(), guard),
  );
  await f.service.run(owner, mutation(bound), guard);
  await f.entered.promise;
  const current = await f.service.get(owner, bound.id, guard);
  let checks = 0;
  const revokeAtCommit = () => {
    checks += 1;
    if (checks > 2) throw new Error("Connection revoked");
  };
  let finished = false;
  const cancelling = f.service.control(
    owner,
    mutation(current),
    "cancel",
    revokeAtCommit,
  );
  void cancelling.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  await Promise.resolve();
  expect(finished).toBe(false);
  cleanup.resolve();
  await expect(cancelling).rejects.toThrow("control");
  expect(f.events).toContain("physically-settled");
});

it("requires explicit rebind after losing session action inputs and hides foreign parents", async () => {
  const f = compositeFixture();
  const bound = await f.bind(
    await f.service.prepare(owner, compositePlan(), guard),
  );
  const restarted = new McpCompositeWorkflowService(f.repository, f.native);
  await expect(restarted.run(owner, mutation(bound), guard)).rejects.toThrow(
    "Session action input",
  );
  await expect(
    restarted.get("foreign-owner", bound.id, guard),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    f.service.prepare(owner, { ...bound.plan, reason: randomUUID() }, guard),
  ).rejects.toThrow("request ID");
  expect(f.events).toEqual([]);
});

it("stops an in-flight admission before native start and close waits for that admission to settle", async () => {
  const f = compositeFixture();
  const verifying = deferred();
  const release = deferred();
  f.native.verify = async (_binding, check) => {
    verifying.resolve();
    await release.promise;
    check();
  };
  const bound = await f.bind(
    await f.service.prepare(owner, compositePlan(), guard),
  );
  const running = f.service.run(owner, mutation(bound), guard);
  const rejected = expect(running).rejects.toMatchObject({
    code: "invalid_edit",
    message: "Composite admissions are stopped.",
  });
  await verifying.promise;
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release.resolve();
  await rejected;
  await closing;
  expect(closed).toBe(true);
  expect(f.events).toEqual([]);
  expect(f.records.get(bound.id)?.used.admissions).toBe(0);
});

it("cancels at the physical-settlement boundary without committing a later refreshed parent advance", async () => {
  const f = compositeFixture();
  const refreshing = deferred();
  const release = deferred();
  const aborted = deferred();
  const execute = f.native.execute;
  f.native.execute = (binding, signal, checkpoint, check) => {
    signal.addEventListener("abort", aborted.resolve, { once: true });
    return execute(binding, signal, checkpoint, check);
  };
  f.native.refresh = async (record) => {
    refreshing.resolve();
    await release.promise;
    return record.snapshot;
  };
  const bound = await f.bind(
    await f.service.prepare(owner, compositePlan(), guard),
  );
  await f.service.run(owner, mutation(bound), guard);
  await refreshing.promise;
  const current = await f.service.get(owner, bound.id, guard);
  const cancelling = f.service.control(
    owner,
    mutation(current),
    "cancel",
    guard,
  );
  await aborted.promise;
  release.resolve();
  await cancelling;
  const cancelled = await f.service.get(owner, bound.id, guard);
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.phases[0].status).toBe("held");
  expect(cancelled.phases[0].outcome?.status).toBe("completed");
  expect(f.events).toEqual(["admitted", "physically-settled"]);
});

it.each([false, true])(
  "observes owned receipt refresh as running without changing durable recovery state (refresh fails: %s)",
  async (failRefresh) => {
    const f = compositeFixture();
    const refreshing = deferred();
    const release = deferred();
    const failure = new Error("Native receipt refresh failed");
    const refresh = f.native.refresh;
    f.native.refresh = async (...args) => {
      refreshing.resolve();
      await release.promise;
      if (failRefresh) throw failure;
      return refresh(...args);
    };
    const plan = compositePlan();
    plan.phases.push({
      kind: "native",
      id: "next",
      action: "workflow-run",
      role: "work",
    });
    const bound = await f.bind(await f.service.prepare(owner, plan, guard));
    const restarted = new McpCompositeWorkflowService(f.repository, f.native);
    await f.service.run(owner, mutation(bound), guard);
    const completion = f.service.waitForCompletion(owner, bound.id, guard).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    try {
      await refreshing.promise;
      const durable = await f.repository.load(owner, bound.id);
      expect(durable).toMatchObject({
        status: "held",
        stopReason: "native-outcome",
        phases: [{ status: "held", outcome: { status: "completed" } }, {}],
        used: { admissions: 1, pageAttempts: 1 },
      });
      const running = await f.service.get(owner, bound.id, guard);
      expect(running).toMatchObject({
        status: "running",
        phases: [{ status: "running", outcome: { status: "completed" } }, {}],
      });
      expect(running).not.toHaveProperty("stopReason");
      expect(f.service.observe(durable)).toEqual(running);
      expect(await f.repository.load(owner, bound.id)).toEqual(durable);
      expect(await restarted.get(owner, bound.id, guard)).toEqual(durable);
      const held = structuredClone(durable);
      held.stopReason = "checkpoint-failed";
      expect(f.service.observe(held)).toEqual(held);
      held.stopReason = "native-outcome";
      const outcome = held.phases[0].outcome;
      if (!outcome) throw new Error("Expected a durable native outcome");
      outcome.status = "failed";
      expect(f.service.observe(held)).toEqual(held);
      for (const status of ["paused", "cancelled"] as const) {
        const controlled = { ...durable, status };
        expect(f.service.observe(controlled)).toEqual(controlled);
      }
      release.resolve();
      const settled = await completion;
      if (failRefresh) {
        expect(settled).toEqual({ status: "rejected", reason: failure });
        expect(await f.service.get(owner, bound.id, guard)).toEqual(durable);
      } else {
        expect(settled).toMatchObject({
          status: "fulfilled",
          value: {
            status: "prepared",
            phases: [{ status: "completed" }, { status: "unbound" }],
            used: { admissions: 1, pageAttempts: 1 },
          },
        });
      }
      expect(f.events).toEqual(["admitted", "physically-settled"]);
    } finally {
      release.resolve();
      await completion;
      await Promise.all([f.service.close(), restarted.close()]);
    }
  },
);
