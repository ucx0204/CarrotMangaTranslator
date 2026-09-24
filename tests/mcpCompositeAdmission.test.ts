import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { McpParentAdmission } from "../src/main/mcp/mcpParentAdmission";
import { McpCompositeWorkflowService } from "../src/main/application/mcpCompositeWorkflowService";
import {
  compositeFixture,
  compositePlan,
  deferred,
  guard,
  mutation,
  owner,
} from "./mcpCompositeWorkflow.fixture";

function workflowInput() {
  return {
    id: randomUUID(),
    version: 0,
    requestId: randomUUID(),
    retryFailed: false,
  };
}
async function boundFixture(
  options: Parameters<typeof compositeFixture>[0] = {},
  reportError?: (error: unknown) => void,
) {
  const f = compositeFixture(options);
  const admission = new McpParentAdmission();
  const service = new McpCompositeWorkflowService(f.repository, f.native, {
    acquire: (record) => admission.acquireComposite(record),
    reportError,
  });
  const prepared = await service.prepare(owner, compositePlan(), guard);
  const action = { kind: "workflow-run" as const, input: workflowInput() };
  const input = {
    ...mutation(prepared),
    phaseId: "work",
    action,
    expectedSnapshot: prepared.snapshot.fingerprint,
    predecessorReceipts: [],
  };
  const bound = await service.bind(owner, input, guard);
  const binding = await f.native.resolve(prepared, input, guard);
  return { ...f, admission, service, bound, binding };
}

it("denies a competing parent before verification, budget reservation or native work", async () => {
  const f = await boundFixture();
  const verify = vi.spyOn(f.native, "verify");
  const reserve = vi.spyOn(f.repository, "reserve");
  const prior = f.admission.acquireWorkflow(owner, workflowInput());
  try {
    await expect(
      f.service.run(owner, mutation(f.bound), guard),
    ).rejects.toMatchObject({ code: "editor_busy" });
    expect(verify).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(
      (await f.service.get(owner, f.bound.id, guard)).used.admissions,
    ).toBe(0);
    expect(f.events).toEqual([]);
  } finally {
    prior.release();
    await f.service.close();
  }
});

it("permits only the exact internal workflow child and keeps its parent lease", async () => {
  const f = await boundFixture();
  const parent = f.admission.acquireComposite(f.bound);
  const input =
    f.binding.action.kind === "workflow-run"
      ? f.binding.action.input
      : undefined;
  if (!input) throw new Error("Expected exact workflow fixture binding");
  try {
    expect(() => f.admission.acquireWorkflow(owner, input)).toThrow(
      "Another workflow",
    );
    await f.admission.executeChild(f.binding, async () => {
      f.admission.acquireWorkflow(owner, input).release();
      expect(f.admission.isActive(f.bound.id)).toBe(true);
      for (const changed of [
        { ...input, requestId: randomUUID() },
        { ...input, version: 1 },
        { ...input, retryFailed: true },
      ])
        expect(() => f.admission.acquireWorkflow(owner, changed)).toThrow(
          "Another workflow",
        );
      expect(() => f.admission.acquireWorkflow("another-owner", input)).toThrow(
        "Another workflow",
      );
    });
    await expect(
      f.admission.executeChild(
        { ...f.binding, compositeId: randomUUID() },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "editor_busy" });
    await expect(
      f.admission.executeChild(
        { ...f.binding, owner: "another-owner" },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "editor_busy" });
  } finally {
    parent.release();
    await f.service.close();
  }
});

it("does not reuse an old asynchronous child capability or release a later parent", async () => {
  const f = await boundFixture();
  const first = f.admission.acquireComposite(f.bound);
  const barrier = deferred();
  const child = f.admission.executeChild(f.binding, async () => {
    await barrier.promise;
    const action = f.binding.action;
    if (action.kind !== "workflow-run")
      throw new Error("Expected workflow action");
    expect(() => f.admission.acquireWorkflow(owner, action.input)).toThrow(
      "Another workflow",
    );
  });
  first.release();
  const second = f.admission.acquireComposite(f.bound);
  try {
    first.release();
    expect(f.admission.isActive(f.bound.id)).toBe(true);
    barrier.resolve();
    await child;
  } finally {
    barrier.resolve();
    second.release();
    await f.service.close();
  }
});

it("keeps admission during cancellation cleanup and replays without charging twice", async () => {
  const cleanup = deferred();
  const f = await boundFixture({ waitForAbort: true, cleanup });
  const checkpointed = deferred();
  const execute = f.native.execute;
  f.native.execute = (binding, signal, checkpoint, check) =>
    execute(
      binding,
      signal,
      async (receipt) => {
        await checkpoint(receipt);
        checkpointed.resolve();
      },
      check,
    );
  const input = mutation(f.bound);
  try {
    await f.service.run(owner, input, guard);
    await checkpointed.promise;
    const replay = await f.service.run(owner, input, guard);
    expect(replay.used.admissions).toBe(1);
    expect(f.events).toEqual(["admitted"]);
    let completed = false;
    const cancellation = f.service
      .control(
        owner,
        mutation(await f.service.get(owner, f.bound.id, guard)),
        "cancel",
        guard,
      )
      .finally(() => {
        completed = true;
      });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(() => f.admission.acquireWorkflow(owner, workflowInput())).toThrow(
      "Another workflow",
    );
    cleanup.resolve();
    await cancellation;
    expect(f.events).toEqual(["admitted", "physically-settled"]);
    expect(f.admission.isActive(f.bound.id)).toBe(false);
    expect(
      (await f.service.get(owner, f.bound.id, guard)).used.admissions,
    ).toBe(1);
  } finally {
    cleanup.resolve();
    await f.service.close();
  }
});

it("releases rejected pre-start verification without changing the saved attempt or budget", async () => {
  const f = await boundFixture();
  f.native.verify = async () => {
    throw new Error("source changed");
  };
  try {
    await expect(
      f.service.run(owner, mutation(f.bound), guard),
    ).rejects.toThrow("source changed");
    expect(f.admission.isActive(f.bound.id)).toBe(false);
    const current = await f.service.get(owner, f.bound.id, guard);
    expect(current.version).toBe(f.bound.version);
    expect(current.used.admissions).toBe(0);
    expect(current.phases[0].attemptId).toBeUndefined();
  } finally {
    await f.service.close();
  }
});

it("holds the same admission gate through direct review rendering", async () => {
  const f = compositeFixture();
  const gate = new McpParentAdmission();
  const entered = deferred();
  const cleanup = deferred();
  const render = f.native.renderEvidence;
  f.native.renderEvidence = async (...args) => {
    entered.resolve();
    await cleanup.promise;
    return render(...args);
  };
  const service = new McpCompositeWorkflowService(f.repository, f.native, {
    acquire: (record) => gate.acquireComposite(record),
  });
  try {
    const prepared = await service.prepare(owner, compositePlan(true), guard);
    await service.run(owner, mutation(prepared), guard);
    await entered.promise;
    expect(() => gate.acquireWorkflow(owner, workflowInput())).toThrow(
      "Another workflow",
    );
    cleanup.resolve();
    expect(
      (await service.waitForCompletion(owner, prepared.id, guard)).status,
    ).toBe("awaiting-review");
    expect(gate.isActive(prepared.id)).toBe(false);
  } finally {
    cleanup.resolve();
    await service.close();
  }
});

it("reports asynchronous native failures after cleanup and preserves the original completion rejection", async () => {
  const reportError = vi.fn();
  const f = await boundFixture({}, reportError);
  const entered = deferred();
  const cleanup = deferred();
  const failure = new Error("Native cleanup failed after checkpoint");
  f.native.execute = async () => {
    entered.resolve();
    await cleanup.promise;
    throw failure;
  };
  try {
    await f.service.run(owner, mutation(f.bound), guard);
    await entered.promise;
    const waiting = f.service.waitForCompletion(owner, f.bound.id, guard);
    const rejected = expect(waiting).rejects.toBe(failure);
    expect(reportError).not.toHaveBeenCalled();
    expect(f.admission.isActive(f.bound.id)).toBe(true);
    cleanup.resolve();
    await rejected;
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(f.admission.isActive(f.bound.id)).toBe(false);
    expect(await f.service.get(owner, f.bound.id, guard)).toMatchObject({
      status: "held",
      stopReason: "checkpoint-failed",
    });
  } finally {
    cleanup.resolve();
    await f.service.close();
  }
});

it.each(["revoked", "stopped"] as const)(
  "blocks preparation replay when authority is %s during its owned lookup",
  async (boundary) => {
    const f = compositeFixture();
    const plan = compositePlan();
    const prepared = await f.service.prepare(owner, plan, guard);
    const entered = deferred();
    const release = deferred();
    const find = f.repository.find.bind(f.repository);
    f.repository.find = async (...args) => {
      const record = await find(...args);
      entered.resolve();
      await release.promise;
      return record;
    };
    const nativePrepare = vi.spyOn(f.native, "prepare");
    const create = vi.spyOn(f.repository, "create");
    let revoked = false;
    const check = () => {
      if (revoked) throw new Error("Connection revoked");
    };
    try {
      const replay = f.service.prepare(owner, plan, check);
      const rejected = expect(replay).rejects.toThrow(
        boundary === "revoked" ? "Connection revoked" : "stopped",
      );
      await entered.promise;
      if (boundary === "revoked") revoked = true;
      else f.service.stop();
      release.resolve();
      await rejected;
      expect(nativePrepare).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(f.records.get(prepared.id)).toEqual(prepared);
      expect(f.events).toEqual([]);
    } finally {
      release.resolve();
      await f.service.close();
    }
  },
);
