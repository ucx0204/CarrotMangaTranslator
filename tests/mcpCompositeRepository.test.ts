import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import {
  compositeFingerprint,
  applyCompositeImport,
} from "../src/main/application/mcpCompositeWorkflowPolicy";
import {
  compositeOwner,
  newCompositeRecord,
  compositeBound,
  compositeReserved,
  compositeOutcome,
  compositeSnapshot,
} from "./mcpCompositeRepository.fixture";

async function setup() {
  const f = await retentionFixture();
  const { McpCompositeRepository } =
    await import("../src/main/mcp/mcpCompositeRepository");
  const repository = new McpCompositeRepository(f.storage);
  return {
    f,
    repository,
    guard: () => undefined,
    restart: () => new McpCompositeRepository(f.storage),
  };
}

it("atomically deduplicates preparation and keeps legacy workflow readers isolated", async () => {
  const t = await setup();
  try {
    const input = newCompositeRecord();
    const twin = { ...input, id: randomUUID() };
    const [first, second] = await Promise.all([
      t.repository.create(input, t.guard),
      t.repository.create(twin, t.guard),
    ]);
    expect(first.id).toBe(second.id);
    expect(
      (await t.repository.list(compositeOwner)).map((record) => record.id),
    ).toEqual([first.id]);
    const { McpWorkflowRepository } =
      await import("../src/main/mcp/mcpWorkflowRepository");
    expect(
      await new McpWorkflowRepository(t.f.storage).list(compositeOwner),
    ).toEqual([]);
    const plan = { ...input.plan, reason: "Different approved scope" };
    await expect(
      t.repository.create(
        { ...input, plan, initialFingerprint: compositeFingerprint(plan) },
        t.guard,
      ),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    await expect(
      t.repository.load("foreign-owner", first.id),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await t.repository.find("foreign-owner", input.plan.requestId),
    ).toBeNull();
    expect(
      await readFile(await t.f.storage.path(first.id), "utf8"),
    ).not.toContain(input.plan.reason);
  } finally {
    await t.f.close();
  }
});

it("requires an atomic durable reservation before issuing a native child capability", async () => {
  const t = await setup();
  try {
    const prepared = await t.repository.create(newCompositeRecord(), t.guard);
    const bound = await t.repository.save(
      compositeBound(prepared),
      prepared.version,
      t.guard,
    );
    const candidate = compositeReserved(bound);
    await expect(
      t.repository.save(candidate, bound.version, t.guard),
    ).rejects.toThrow("reservation");
    const admitted = await t.repository.reserve(
      candidate,
      bound.version,
      t.guard,
    );
    expect(await t.f.storage.record(prepared.id)).toMatchObject({
      used: { admissions: 1, pageAttempts: 1 },
      phases: [{ attemptId: candidate.phases[0].attemptId, status: "running" }],
    });
    expect(t.repository.isActive(prepared.id)).toBe(true);
    await expect(
      t.repository.discard(compositeOwner, prepared.id, t.guard),
    ).rejects.toMatchObject({ code: "editor_busy" });
    await expect(
      t.repository.reserve(candidate, bound.version, t.guard),
    ).rejects.toMatchObject({ code: "editor_busy" });
    await admitted.settlement.hold("interrupted");
    expect(t.repository.isActive(prepared.id)).toBe(false);
    expect(
      (await t.restart().load(compositeOwner, prepared.id)).used.admissions,
    ).toBe(1);
    await expect(
      t.restart().reserve(candidate, bound.version, t.guard),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  } finally {
    await t.f.close();
  }
});

it("rolls back a reservation if approval is revoked after encrypted staging", async () => {
  const t = await setup();
  const signal = new AbortController();
  const original = t.f.storage.stageRecord.bind(t.f.storage);
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const prepared = await t.repository.create(newCompositeRecord(), t.guard);
    const bound = await t.repository.save(
      compositeBound(prepared),
      prepared.version,
      t.guard,
    );
    spy = vi
      .spyOn(t.f.storage, "stageRecord")
      .mockImplementation(async (...args) => {
        await original(...args);
        signal.abort(new Error("revoked before admission"));
      });
    await expect(
      t.repository.reserve(compositeReserved(bound), bound.version, () =>
        signal.signal.throwIfAborted(),
      ),
    ).rejects.toThrow("revoked before admission");
    spy.mockRestore();
    expect(await t.repository.load(compositeOwner, prepared.id)).toEqual(bound);
    expect(t.repository.isActive(prepared.id)).toBe(false);
  } finally {
    spy?.mockRestore();
    await t.f.close();
  }
});

it("settles the issued child after cancellation while preserving exact partial outcome identity", async () => {
  const t = await setup();
  try {
    const prepared = await t.repository.create(newCompositeRecord(), t.guard);
    const bound = await t.repository.save(
      compositeBound(prepared),
      prepared.version,
      t.guard,
    );
    const admitted = await t.repository.reserve(
      compositeReserved(bound),
      bound.version,
      t.guard,
    );
    const outcome = compositeOutcome(admitted.record, "partial");
    const cancelled = {
      ...admitted.record,
      version: admitted.record.version + 1,
      status: "cancelled" as const,
    };
    await t.repository.save(cancelled, admitted.record.version, t.guard);
    const checkpoint = await admitted.settlement.checkpointChild(
      outcome.receipt,
    );
    expect(checkpoint.status).toBe("cancelled");
    const settled = await admitted.settlement.finish(outcome);
    expect(settled).toMatchObject({
      status: "cancelled",
      used: { admissions: 1 },
      phases: [{ status: "held", child: outcome.receipt, outcome }],
    });
    await expect(
      t.repository.save(
        { ...settled, version: settled.version + 1, status: "prepared" },
        settled.version,
        t.guard,
      ),
    ).rejects.toThrow("terminal");
    expect(await admitted.settlement.finish(outcome)).toEqual(settled);
    await expect(
      admitted.settlement.finish({
        ...outcome,
        receipt: { ...outcome.receipt, id: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    const overwritten = structuredClone(settled);
    overwritten.version += 1;
    delete overwritten.phases[0].outcome;
    await expect(
      t.repository.save(overwritten, settled.version, t.guard),
    ).rejects.toThrow("outcomes");
  } finally {
    await t.f.close();
  }
});

it("expires owned reads and admissions while allowing the already issued child's cleanup settlement", async () => {
  const t = await setup();
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const prepared = await t.repository.create(newCompositeRecord(), t.guard);
    const bound = await t.repository.save(
      compositeBound(prepared),
      prepared.version,
      t.guard,
    );
    const admitted = await t.repository.reserve(
      compositeReserved(bound),
      bound.version,
      t.guard,
    );
    const outcome = compositeOutcome(admitted.record, "partial");
    clock = vi
      .spyOn(t.f.storage, "now")
      .mockReturnValue(prepared.expiresAt + 1);
    await expect(
      t.repository.load(compositeOwner, prepared.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      t.repository.save(
        {
          ...admitted.record,
          version: admitted.record.version + 1,
          status: "cancelled",
        },
        admitted.record.version,
        t.guard,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const settled = await admitted.settlement.finish(outcome);
    expect(settled.phases[0].outcome).toEqual(outcome);
    expect(settled.expiresAt).toBe(prepared.expiresAt);
    expect(t.repository.isActive(prepared.id)).toBe(false);
    expect(await t.f.storage.record(prepared.id)).toMatchObject({
      phases: [{ outcome }],
    });
    await expect(
      t.repository.load(compositeOwner, prepared.id),
    ).rejects.toMatchObject({ code: "not_found" });
  } finally {
    clock?.mockRestore();
    await t.f.close();
  }
});

it("publishes imported target metadata and catalog pageCount in one transaction", async () => {
  const t = await setup();
  try {
    const prepared = await t.repository.create(
      newCompositeRecord(true),
      t.guard,
    );
    expect(
      (await t.f.storage.index()).entries.find(
        (entry) => entry.id === prepared.id,
      )?.pageCount,
    ).toBe(0);
    const bound = await t.repository.save(
      compositeBound(prepared),
      prepared.version,
      t.guard,
    );
    const admitted = await t.repository.reserve(
      compositeReserved(bound),
      bound.version,
      t.guard,
    );
    const outcome = compositeOutcome(admitted.record);
    const settled = await admitted.settlement.finish(outcome);
    expect(settled.targets).toEqual([]);
    const refreshed = structuredClone(settled);
    applyCompositeImport(refreshed, outcome);
    refreshed.snapshot = compositeSnapshot(refreshed.targets);
    refreshed.phases[0].status = "completed";
    refreshed.status = "completed";
    refreshed.version += 1;
    delete refreshed.stopReason;
    await t.repository.save(refreshed, settled.version, t.guard);
    expect(
      (await t.f.storage.index()).entries.find(
        (entry) => entry.id === prepared.id,
      )?.pageCount,
    ).toBe(1);
    expect(await t.restart().load(compositeOwner, prepared.id)).toEqual(
      refreshed,
    );
  } finally {
    await t.f.close();
  }
});

it("keeps an old settled capability from releasing a later child's active pin", async () => {
  const t = await setup();
  try {
    const prepared = await t.repository.create(
      newCompositeRecord(false, true),
      t.guard,
    );
    const bound = await t.repository.save(
      compositeBound(prepared),
      prepared.version,
      t.guard,
    );
    const first = await t.repository.reserve(
      compositeReserved(bound),
      bound.version,
      t.guard,
    );
    const outcome = compositeOutcome(first.record);
    const settled = await first.settlement.finish(outcome);
    const advanced = structuredClone(settled);
    advanced.phases[0].status = "completed";
    advanced.status = "prepared";
    advanced.version += 1;
    delete advanced.stopReason;
    const saved = await t.repository.save(advanced, settled.version, t.guard);
    const boundNext = await t.repository.save(
      compositeBound(saved, 1),
      saved.version,
      t.guard,
    );
    const next = await t.repository.reserve(
      compositeReserved(boundNext, 1),
      boundNext.version,
      t.guard,
    );
    await first.settlement.finish(outcome);
    await first.settlement.hold("interrupted");
    expect(t.repository.isActive(prepared.id)).toBe(true);
    await next.settlement.hold("interrupted");
    expect(t.repository.isActive(prepared.id)).toBe(false);
    expect(
      (await t.repository.load(compositeOwner, prepared.id)).used.admissions,
    ).toBe(2);
  } finally {
    await t.f.close();
  }
});
