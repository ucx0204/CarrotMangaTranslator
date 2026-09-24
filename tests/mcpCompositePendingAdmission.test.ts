import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { McpCompositeWorkflowService } from "../src/main/application/mcpCompositeWorkflowService";
import type { McpCompositeRecord } from "../src/main/application/mcpCompositeWorkflowPorts";
import {
  compositeFixture,
  compositePlan,
  deferred,
  guard,
  hash,
  mutation,
  owner,
} from "./mcpCompositeWorkflow.fixture";

it.each(["native", "review"] as const)(
  "cancels %s admission committed before its reservation returns and drains the owned lease",
  async (kind) => {
    const f = pendingAdmissionFixture(kind);
    const prepared = await f.service.prepare(
      owner,
      compositePlan(kind === "review"),
      guard,
    );
    const ready =
      kind === "native"
        ? await bindPendingNative(f.service, prepared)
        : prepared;
    const running = Promise.allSettled([
      f.service.run(owner, mutation(ready), guard),
    ]);
    let cancellation:
      | Promise<PromiseSettledResult<McpCompositeRecord>>
      | undefined;
    try {
      await f.reserved.promise;
      const committed = await f.repository.load(owner, ready.id);
      expect(committed).toMatchObject({
        status: "running",
        used: { admissions: 1, pageAttempts: 1 },
      });
      expect(f.leaseEvents).toEqual(["acquired"]);
      const cancel = f.service.control(
        owner,
        mutation(committed),
        "cancel",
        guard,
      );
      cancellation = Promise.allSettled([cancel]).then(([result]) => result);
      await f.cancelSaved.promise;
      expect((await f.repository.load(owner, ready.id)).status).toBe(
        "cancelled",
      );
      f.releaseReservation.resolve();
      const boundary = await Promise.race([
        f.settling.promise.then(() => "settling"),
        f.nativeEntered.promise.then(() => "native-started"),
        cancellation.then(() => "cancel-returned-before-drain"),
      ]);
      expect(boundary).toBe("settling");
      expect(f.events).toEqual([]);
      expect(f.leaseEvents).toEqual(["acquired"]);
      let controlFinished = false;
      void cancellation.then(() => {
        controlFinished = true;
      });
      await Promise.resolve();
      expect(controlFinished).toBe(false);
      f.releaseSettlement.resolve();
      const outcome = await cancellation;
      expect(outcome.status).toBe("fulfilled");
      if (outcome.status === "fulfilled")
        expect(outcome.value.status).toBe("cancelled");
      expect(await running).toEqual([
        {
          status: "rejected",
          reason: expect.objectContaining({ name: "AbortError" }),
        },
      ]);
      const settled = await f.service.get(owner, ready.id, guard);
      expect(settled).toMatchObject({
        status: "cancelled",
        used: { admissions: 1, pageAttempts: 1 },
      });
      expect(settled.phases[0].status).toBe("held");
      expect(settled.phases[0].evidence).toBeUndefined();
      expect(settled.phases[0].child).toBeUndefined();
      if (kind === "native")
        expect(settled.phases[0].attemptId).toBe(committed.phases[0].attemptId);
      expect(f.events).toEqual([]);
      expect(f.leaseEvents).toEqual([
        "acquired",
        "settlement-finished",
        "released",
      ]);
    } finally {
      f.releaseReservation.resolve();
      f.releaseSettlement.resolve();
      await Promise.allSettled([running, cancellation]);
      await f.service.close();
    }
  },
);

it("carries a pause across committed pending admission and holds the parent lease until native cleanup", async () => {
  const f = pendingAdmissionFixture("native");
  const cleanup = deferred();
  const plan = compositePlan();
  plan.phases.push({
    kind: "native",
    id: "later-work",
    action: "workflow-run",
    role: "work",
  });
  f.native.execute = async (binding, signal, checkpoint, check) => {
    check();
    signal.throwIfAborted();
    const stored = await f.repository.load(owner, binding.compositeId);
    expect(stored).toMatchObject({ status: "paused", used: { admissions: 1 } });
    expect(stored.phases[0]).toMatchObject({
      status: "running",
      attemptId: expect.any(String),
    });
    f.events.push("admitted");
    f.entered.resolve();
    const receipt = {
      kind: "workflow" as const,
      id: randomUUID(),
      requestId: binding.nativeRequestId,
      family: binding.family,
      inputFingerprint: binding.inputFingerprint,
    };
    try {
      await checkpoint(receipt);
      return { status: "completed", receipt, resultFingerprint: hash() };
    } finally {
      await cleanup.promise;
      f.events.push("physically-settled");
    }
  };
  const prepared = await f.service.prepare(owner, plan, guard);
  const ready = await bindPendingNative(f.service, prepared);
  const running = Promise.allSettled([
    f.service.run(owner, mutation(ready), guard),
  ]);
  let pausing: Promise<PromiseSettledResult<McpCompositeRecord>> | undefined;
  try {
    await f.reserved.promise;
    const committed = await f.repository.load(owner, ready.id);
    pausing = Promise.allSettled([
      f.service.control(owner, mutation(committed), "pause", guard),
    ]).then(([result]) => result);
    await f.pauseSaved.promise;
    f.releaseReservation.resolve();
    await f.entered.promise;
    expect(f.events).toEqual(["admitted"]);
    expect(f.leaseEvents).toEqual(["acquired"]);
    let physicallyDone = false;
    const completion = f.service
      .waitForCompletion(owner, ready.id, guard)
      .then((record) => {
        physicallyDone = true;
        return record;
      });
    await Promise.resolve();
    expect(physicallyDone).toBe(false);
    cleanup.resolve();
    expect((await pausing).status).toBe("fulfilled");
    const settled = await completion;
    await running;
    expect(settled).toMatchObject({
      status: "paused",
      used: { admissions: 1, pageAttempts: 1 },
    });
    expect(settled.phases.map((phase) => phase.status)).toEqual([
      "completed",
      "unbound",
    ]);
    expect(f.events).toEqual(["admitted", "physically-settled"]);
    expect(f.leaseEvents).toEqual(["acquired", "released"]);
  } finally {
    f.releaseReservation.resolve();
    f.releaseSettlement.resolve();
    cleanup.resolve();
    await Promise.allSettled([running, pausing]);
    await f.service.close();
  }
});

function pendingAdmissionFixture(kind: "native" | "review") {
  const f = compositeFixture();
  const reserved = deferred(),
    releaseReservation = deferred(),
    cancelSaved = deferred(),
    pauseSaved = deferred();
  const settling = deferred(),
    releaseSettlement = deferred(),
    nativeEntered = deferred();
  const leaseEvents: string[] = [];
  let leaseActive = false;
  const service = new McpCompositeWorkflowService(f.repository, f.native, {
    acquire: () => {
      expect(leaseActive).toBe(false);
      leaseActive = true;
      leaseEvents.push("acquired");
      return {
        release: () => {
          expect(leaseActive).toBe(true);
          leaseActive = false;
          leaseEvents.push("released");
        },
      };
    },
  });
  const execute = f.native.execute,
    render = f.native.renderEvidence;
  f.native.execute = (...args) => {
    nativeEntered.resolve();
    return execute(...args);
  };
  f.native.renderEvidence = (...args) => {
    nativeEntered.resolve();
    return render(...args);
  };
  const reserve = f.repository.reserve,
    save = f.repository.save;
  f.repository.reserve = async (...args) => {
    const reservation = await reserve(...args);
    const hold = reservation.settlement.hold;
    reservation.settlement.hold = async (reason) => {
      settling.resolve();
      await releaseSettlement.promise;
      const saved = await hold(reason);
      leaseEvents.push("settlement-finished");
      return saved;
    };
    reserved.resolve();
    await releaseReservation.promise;
    return reservation;
  };
  f.repository.save = async (record, version, check) => {
    const isReviewHold =
      kind === "review" && record.phases[0].status === "held";
    if (isReviewHold) {
      settling.resolve();
      await releaseSettlement.promise;
    }
    const saved = await save(record, version, check);
    if (saved.status === "cancelled" && saved.phases[0].status === "running")
      cancelSaved.resolve();
    if (saved.status === "paused" && saved.phases[0].status === "running")
      pauseSaved.resolve();
    if (kind === "review" && saved.status === "running") {
      reserved.resolve();
      await releaseReservation.promise;
    }
    if (isReviewHold) leaseEvents.push("settlement-finished");
    return saved;
  };
  return {
    ...f,
    service,
    reserved,
    releaseReservation,
    cancelSaved,
    pauseSaved,
    settling,
    releaseSettlement,
    nativeEntered,
    leaseEvents,
  };
}

function bindPendingNative(
  service: McpCompositeWorkflowService,
  record: McpCompositeRecord,
) {
  return service.bind(
    owner,
    {
      ...mutation(record),
      phaseId: record.phases[0].id,
      action: {
        kind: "workflow-run",
        input: {
          id: randomUUID(),
          requestId: randomUUID(),
          version: 0,
          retryFailed: false,
        },
      },
      expectedSnapshot: record.snapshot.fingerprint,
      predecessorReceipts: [],
    },
    guard,
  );
}
