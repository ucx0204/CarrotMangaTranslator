import { readFile } from "node:fs/promises";
import { ok } from "node:assert/strict";
import { expect, it, vi } from "vitest";
import type { McpCompositeRecord } from "../src/main/application/mcpCompositeWorkflowPorts";
import {
  applyCompositeImport,
  compositeFingerprint,
  reserveCompositeCost,
  zeroCompositeCost,
} from "../src/main/application/mcpCompositeWorkflowPolicy";
import { retentionFixture } from "./mcpRetention.fixture";
import {
  compositeBound,
  compositeDigest,
  compositeEvidence,
  compositeOutcome,
  compositeOwner,
  compositePage,
  compositeReserved,
  compositeSnapshot,
  newCompositeRecord,
} from "./mcpCompositeRepository.fixture";

async function setup(input = newCompositeRecord()) {
  const f = await retentionFixture();
  const { McpCompositeRepository } =
    await import("../src/main/mcp/mcpCompositeRepository");
  const repository = new McpCompositeRepository(f.storage);
  const guard = () => undefined;
  const prepared = await repository.create(input, guard);
  return { f, repository, guard, prepared };
}
function completed(record: McpCompositeRecord) {
  const next = structuredClone(record);
  next.phases[0].status = "completed";
  next.status = next.phases.length === 1 ? "completed" : "prepared";
  next.version += 1;
  delete next.stopReason;
  return next;
}

it("does not advance a settled phase when current authorization is revoked at publication", async () => {
  const t = await setup();
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const bound = await t.repository.save(
      compositeBound(t.prepared),
      t.prepared.version,
      t.guard,
    );
    const admitted = await t.repository.reserve(
      compositeReserved(bound),
      bound.version,
      t.guard,
    );
    const held = await admitted.settlement.finish(
      compositeOutcome(admitted.record),
    );
    const before = await readFile(await t.f.storage.path(held.id));
    const revoked = new AbortController();
    const stage = t.f.storage.stageRecord.bind(t.f.storage);
    spy = vi
      .spyOn(t.f.storage, "stageRecord")
      .mockImplementation(async (...args) => {
        await stage(...args);
        revoked.abort(new Error("Revoked before phase advancement"));
      });
    await expect(
      t.repository.save(completed(held), held.version, () =>
        revoked.signal.throwIfAborted(),
      ),
    ).rejects.toThrow("Revoked before phase advancement");
    spy.mockRestore();
    expect(await t.repository.load(compositeOwner, held.id)).toEqual(held);
    expect(await readFile(await t.f.storage.path(held.id))).toEqual(before);
    expect(held.phases[0].outcome?.status).toBe("completed");
    expect(held.status).toBe("held");
  } finally {
    spy?.mockRestore();
    await t.f.close();
  }
});

for (const point of ["after-replace-step", "after-commit-point"] as const) {
  it(`recovers imported targets and index pageCount together at ${point}`, async () => {
    const t = await setup(newCompositeRecord(true));
    const transaction =
      await import("../src/main/libraryStore/libraryTransaction");
    const recovery =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let restore = () => {};
    try {
      const bound = await t.repository.save(
        compositeBound(t.prepared),
        t.prepared.version,
        t.guard,
      );
      const admitted = await t.repository.reserve(
        compositeReserved(bound),
        bound.version,
        t.guard,
      );
      const outcome = compositeOutcome(admitted.record);
      const held = await admitted.settlement.finish(outcome);
      const next = completed(held);
      applyCompositeImport(next, outcome);
      next.snapshot = compositeSnapshot(next.targets);
      restore = transaction.setLibraryTransactionCrashInjectorForTests(
        (position) => {
          if (position === point)
            throw new transaction.SimulatedLibraryTransactionCrash(position);
        },
      );
      await expect(
        t.repository.save(next, held.version, t.guard),
      ).rejects.toThrow();
      restore();
      await recovery.recoverLibraryTransactions();
      const record = await t.repository.load(compositeOwner, held.id);
      const entry = (await t.f.storage.index()).entries.find(
        (item) => item.id === held.id,
      );
      const expected = point === "after-commit-point" ? 1 : 0;
      expect(record.targets).toHaveLength(expected);
      expect(entry?.pageCount).toBe(expected);
      expect(record.phases[0].outcome).toEqual(outcome);
      expect(record.used.admissions).toBe(1);
    } finally {
      restore();
      await t.f.close();
    }
  });
}

it("cannot move reserved edits between pages or reset their cumulative cap across phases", async () => {
  const input = newCompositeRecord(false, true);
  const secondPage = { ...compositePage, pageId: "second-page" };
  input.targets = [compositePage, secondPage];
  input.plan.targets = { kind: "saved", pages: input.targets };
  input.plan.budgets.selectedEdits = 150;
  input.snapshot = compositeSnapshot(input.targets);
  input.initialFingerprint = compositeFingerprint(input.plan);
  const t = await setup(input);
  try {
    const candidate = compositeBound(t.prepared);
    ok(candidate.phases[0].binding);
    candidate.phases[0].binding.cost.selectedEdits = 60;
    candidate.phases[0].binding.cost.pageEdits = [
      {
        chapterId: compositePage.chapterId,
        pageId: compositePage.pageId,
        edits: 60,
      },
    ];
    const bound = await t.repository.save(
      candidate,
      t.prepared.version,
      t.guard,
    );
    const admitted = await t.repository.reserve(
      compositeReserved(bound),
      bound.version,
      t.guard,
    );
    const held = await admitted.settlement.finish(
      compositeOutcome(admitted.record),
    );
    const shifted = structuredClone(held);
    shifted.version += 1;
    shifted.used.pageEdits[0].pageId = secondPage.pageId;
    await expect(
      t.repository.save(shifted, held.version, t.guard),
    ).rejects.toThrow("moved to another page");
    const advanced = await t.repository.save(
      completed(held),
      held.version,
      t.guard,
    );
    const next = compositeBound(advanced, 1);
    ok(next.phases[1].binding);
    next.phases[1].binding.cost.selectedEdits = 41;
    next.phases[1].binding.cost.pageEdits = [
      {
        chapterId: compositePage.chapterId,
        pageId: compositePage.pageId,
        edits: 41,
      },
    ];
    const nextBound = await t.repository.save(next, advanced.version, t.guard);
    expect(() => compositeReserved(nextBound, 1)).toThrow("remaining budget");
    const saved = await t.repository.load(compositeOwner, held.id);
    expect(saved.used.selectedEdits).toBe(60);
    expect(saved.used.admissions).toBe(1);
    expect(saved.phases[1].attemptId).toBeUndefined();
  } finally {
    await t.f.close();
  }
});

it("rejects synthetic history at creation and mutation of already-issued review evidence", async () => {
  const input = newCompositeRecord();
  input.plan.phases = [{ kind: "review", id: "review" }];
  input.phases = [{ id: "review", status: "unbound" }];
  input.initialFingerprint = compositeFingerprint(input.plan);
  const t = await setup(input);
  try {
    for (const change of [
      { usageUnknown: true },
      { reviewPairs: [compositeDigest] },
    ]) {
      await expect(
        t.repository.create({ ...newCompositeRecord(), ...change }, t.guard),
      ).rejects.toThrow("history");
    }
    const reserved = structuredClone(t.prepared);
    reserveCompositeCost(reserved, {
      ...zeroCompositeCost(),
      admissions: 1,
      pageAttempts: 1,
    });
    reserved.version += 1;
    reserved.status = "running";
    reserved.phases[0].status = "running";
    const running = await t.repository.save(
      reserved,
      t.prepared.version,
      t.guard,
    );
    const issued = structuredClone(running);
    issued.version += 1;
    issued.status = "awaiting-review";
    issued.phases[0].status = "awaiting-review";
    issued.phases[0].evidence = [compositeEvidence(issued)];
    const saved = await t.repository.save(issued, running.version, t.guard);
    const replaced = structuredClone(saved);
    replaced.version += 1;
    ok(replaced.phases[0].evidence);
    replaced.phases[0].evidence[0].sha256 = "f".repeat(64);
    await expect(
      t.repository.save(replaced, saved.version, t.guard),
    ).rejects.toThrow("issued review evidence");
    expect(await t.repository.load(compositeOwner, saved.id)).toEqual(saved);
  } finally {
    await t.f.close();
  }
});
