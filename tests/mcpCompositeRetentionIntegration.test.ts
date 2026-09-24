import { expect, it, vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import {
  compositeBound,
  compositeOutcome,
  compositeOwner,
  compositeReserved,
  newCompositeRecord,
} from "./mcpCompositeRepository.fixture";
import {
  compositeFingerprint,
  reserveCompositeCost,
  zeroCompositeCost,
} from "../src/main/application/mcpCompositeWorkflowPolicy";

async function setup() {
  const f = await retentionFixture();
  const { McpRetentionStorage } =
    await import("../src/main/mcp/mcpRetentionStorage");
  const { McpCompositeRepository } =
    await import("../src/main/mcp/mcpCompositeRepository");
  const { McpRetentionCatalog } =
    await import("../src/main/mcp/mcpRetentionCatalog");
  const { McpParentAdmission } =
    await import("../src/main/mcp/mcpParentAdmission");
  const { McpEditError } =
    await import("../src/main/application/mcpEditPolicy");
  const { withLibraryMutation } = await import("../src/main/library/lock");
  const { runLibraryTransaction } =
    await import("../src/main/libraryStore/libraryTransaction");
  let now = Date.now();
  const admission = new McpParentAdmission();
  const activeSettlement = vi.fn(
    (id: string) => repository.isActive(id) || admission.isActive(id),
  );
  const storage = new McpRetentionStorage(f.codec, () => now, activeSettlement);
  const repository: InstanceType<typeof McpCompositeRepository> =
    new McpCompositeRepository(storage);
  const guard = () => undefined;
  const discardable = vi.fn((kind: string, id: string) => {
    if (kind !== "composite-workflow") return;
    admission.assertDiscardable(id);
    if (repository.isActive(id))
      throw new McpEditError("editor_busy", "Owned child cleanup is active.");
  });
  const catalog = new McpRetentionCatalog(
    storage,
    new AbortController().signal,
    true,
    discardable,
  );
  const prune = () =>
    withLibraryMutation(() =>
      runLibraryTransaction(
        "test-composite-retention-prune",
        async (transaction) => {
          const index = await storage.prune(transaction, await storage.index());
          await storage.stageIndex(transaction, index);
        },
      ),
    );
  return {
    f,
    storage,
    repository,
    admission,
    catalog,
    discardable,
    activeSettlement,
    guard,
    prune,
    expire: async () => {
      now =
        Math.max(
          ...(await storage.index()).entries.map((entry) => entry.expiresAt),
        ) + 1;
    },
  };
}

it("pins only live composite settlement through expiry while ordinary expired history still prunes", async () => {
  const t = await setup();
  try {
    await t.f.edit("An independently retained ordinary edit");
    const ordinary = (await t.f.list()).items[0].id;
    const inactive = await t.repository.create(
      newCompositeRecord(true),
      t.guard,
    );
    expect(
      (await t.storage.index()).entries.find(
        (entry) => entry.id === inactive.id,
      ),
    ).toMatchObject({
      kind: "composite-workflow",
      operation: "carrot_prepare_composite",
      pageCount: 0,
      mimeType: null,
      sha256: null,
    });
    const prepared = await t.repository.create(newCompositeRecord(), t.guard);
    const bound = await t.repository.save(
      compositeBound(prepared),
      prepared.version,
      t.guard,
    );
    const active = await t.repository.reserve(
      compositeReserved(bound),
      bound.version,
      t.guard,
    );
    await expect(
      t.catalog.discard(compositeOwner, prepared.id, t.guard),
    ).rejects.toMatchObject({ code: "editor_busy" });
    expect(t.discardable).toHaveBeenCalledWith(
      "composite-workflow",
      prepared.id,
    );
    await t.expire();
    t.activeSettlement.mockClear();
    await t.prune();
    const ids = (await t.storage.index()).entries.map((entry) => entry.id);
    expect(ids).toContain(prepared.id);
    expect(ids).not.toContain(inactive.id);
    expect(ids).not.toContain(ordinary);
    expect(t.activeSettlement.mock.calls.some(([id]) => id === ordinary)).toBe(
      false,
    );
    await expect(
      t.repository.load(compositeOwner, prepared.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      t.catalog.discard(compositeOwner, prepared.id, t.guard),
    ).rejects.toMatchObject({ code: "editor_busy" });
    const settled = await active.settlement.finish(
      compositeOutcome(active.record, "partial"),
    );
    expect(settled.status).toBe("held");
    expect(settled.expiresAt).toBe(prepared.expiresAt);
    expect(t.repository.isActive(prepared.id)).toBe(false);
    await t.prune();
    expect(
      (await t.storage.index()).entries.some(
        (entry) => entry.id === prepared.id,
      ),
    ).toBe(false);
  } finally {
    await t.f.close();
  }
});

it("pins a direct review render through the parent gate without inventing a native child lease", async () => {
  const t = await setup();
  let release = () => {};
  try {
    const input = newCompositeRecord();
    input.plan.phases = [{ id: "review", kind: "review" }];
    input.phases = [{ id: "review", status: "unbound" }];
    input.initialFingerprint = compositeFingerprint(input.plan);
    const prepared = await t.repository.create(input, t.guard);
    release = t.admission.acquireComposite(prepared).release;
    const candidate = structuredClone(prepared);
    reserveCompositeCost(candidate, {
      ...zeroCompositeCost(),
      admissions: 1,
      pageAttempts: candidate.targets.length,
    });
    candidate.status = "running";
    candidate.phases[0].status = "running";
    candidate.version += 1;
    await t.repository.save(candidate, prepared.version, t.guard);
    expect(t.repository.isActive(prepared.id)).toBe(false);
    expect(t.admission.isActive(prepared.id)).toBe(true);
    await expect(
      t.catalog.discard(compositeOwner, prepared.id, t.guard),
    ).rejects.toMatchObject({ code: "editor_busy" });
    await t.expire();
    await t.prune();
    expect(
      (await t.storage.index()).entries.some(
        (entry) => entry.id === prepared.id,
      ),
    ).toBe(true);
    await expect(
      t.repository.load(compositeOwner, prepared.id),
    ).rejects.toMatchObject({ code: "not_found" });
    release();
    await t.prune();
    expect(
      (await t.storage.index()).entries.some(
        (entry) => entry.id === prepared.id,
      ),
    ).toBe(false);
  } finally {
    release();
    await t.f.close();
  }
});
