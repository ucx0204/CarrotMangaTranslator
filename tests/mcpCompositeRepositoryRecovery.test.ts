import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import {
  compositeOwner,
  newCompositeRecord,
  compositeBound,
  compositeReserved,
  compositeOutcome,
} from "./mcpCompositeRepository.fixture";

async function setup() {
  const f = await retentionFixture();
  const { McpCompositeRepository } =
    await import("../src/main/mcp/mcpCompositeRepository");
  const repository = new McpCompositeRepository(f.storage);
  const guard = () => undefined;
  const prepared = await repository.create(newCompositeRecord(), guard);
  const bound = await repository.save(
    compositeBound(prepared),
    prepared.version,
    guard,
  );
  return {
    f,
    repository,
    guard,
    bound,
    restart: () => new McpCompositeRepository(f.storage),
  };
}

for (const point of ["after-replace-step", "after-commit-point"] as const) {
  it(`does not start a child when durable reservation loses its reply at ${point}`, async () => {
    const t = await setup();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const recovery =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let restore = () => {};
    const nativeAdmission = vi.fn();
    try {
      const candidate = compositeReserved(t.bound);
      restore = tx.setLibraryTransactionCrashInjectorForTests((position) => {
        if (position === point)
          throw new tx.SimulatedLibraryTransactionCrash(position);
      });
      await expect(
        t.repository
          .reserve(candidate, t.bound.version, t.guard)
          .then(nativeAdmission),
      ).rejects.toThrow();
      expect(nativeAdmission).not.toHaveBeenCalled();
      restore();
      await recovery.recoverLibraryTransactions();
      const restarted = t.restart();
      const record = await restarted.load(compositeOwner, t.bound.id);
      expect(record.used.admissions).toBe(
        point === "after-commit-point" ? 1 : 0,
      );
      expect(record.phases[0].status).toBe(
        point === "after-commit-point" ? "running" : "bound",
      );
      expect(restarted.isActive(record.id)).toBe(false);
      if (point === "after-commit-point") {
        await expect(
          restarted.reserve(candidate, t.bound.version, t.guard),
        ).rejects.toMatchObject({ code: "revision_conflict" });
        expect(record.phases[0].binding?.nativeRequestId).toBe(
          candidate.phases[0].binding?.nativeRequestId,
        );
      }
    } finally {
      restore();
      await t.f.close();
    }
  });
}

for (const point of ["after-replace-step", "after-commit-point"] as const) {
  it(`preserves the exact checkpointed child when settlement fails at ${point}`, async () => {
    const t = await setup();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const recovery =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let restore = () => {};
    try {
      const admitted = await t.repository.reserve(
        compositeReserved(t.bound),
        t.bound.version,
        t.guard,
      );
      const outcome = compositeOutcome(admitted.record, "partial");
      await admitted.settlement.checkpointChild(outcome.receipt);
      await t.f.edit("Unrelated native recovery remains independently owned");
      const nativeChange = (await t.f.list()).items[0].id;
      const nativeBytes = await readFile(await t.f.storage.path(nativeChange));
      restore = tx.setLibraryTransactionCrashInjectorForTests((position) => {
        if (position === point)
          throw new tx.SimulatedLibraryTransactionCrash(position);
      });
      await expect(admitted.settlement.finish(outcome)).rejects.toThrow();
      restore();
      await recovery.recoverLibraryTransactions();
      const record = await t.restart().load(compositeOwner, t.bound.id);
      expect(record.phases[0].child).toEqual(outcome.receipt);
      expect(record.phases[0].outcome).toEqual(
        point === "after-commit-point" ? outcome : undefined,
      );
      expect(record.status).not.toBe("completed");
      expect(record.used.admissions).toBe(1);
      expect(await readFile(await t.f.storage.path(nativeChange))).toEqual(
        nativeBytes,
      );
      expect(t.repository.isActive(t.bound.id)).toBe(false);
      const retried = await admitted.settlement.finish(outcome);
      expect(retried.phases[0].outcome).toEqual(outcome);
      expect(retried.used).toEqual(record.used);
      expect(retried.version).toBe(
        record.version + (point === "after-commit-point" ? 0 : 1),
      );
      expect(await admitted.settlement.finish(outcome)).toEqual(retried);
    } finally {
      restore();
      await t.f.close();
    }
  });
}

it("keeps an actual format-1 workflow byte-identical in the shared encrypted catalog", async () => {
  const t = await setup();
  try {
    const { McpWorkflowRepository } =
      await import("../src/main/mcp/mcpWorkflowRepository");
    const workflows = new McpWorkflowRepository(t.f.storage);
    const page = (await t.f.snapshot()).pages[0];
    const revision = createPageRevision(page);
    const fingerprint = "a".repeat(16);
    const input = {
      requestId: randomUUID(),
      reason: "Legacy exact workflow record",
      chapters: [
        { chapterId: "chapter", pages: [{ pageId: page.id, revision }] },
      ],
      stages: [
        { kind: "await-external" as const, purpose: "reading" as const },
      ],
      maxPageAttempts: 1,
      maxTranslationRequests: 0,
    };
    const legacy = await workflows.create(
      compositeOwner,
      input,
      [
        {
          workId: "work",
          chapterId: "chapter",
          pageId: page.id,
          revision,
          reviewRevision: revision,
          membership: fingerprint,
          contextRevision: fingerprint,
          fingerprint,
          sourceFingerprint: fingerprint,
        },
      ],
      fingerprint,
      t.guard,
    );
    const bytes = await readFile(await t.f.storage.path(legacy.id));
    const admitted = await t.repository.reserve(
      compositeReserved(t.bound),
      t.bound.version,
      t.guard,
    );
    await admitted.settlement.hold("interrupted");
    expect(
      (await workflows.list(compositeOwner)).map((record) => record.id),
    ).toEqual([legacy.id]);
    expect(
      (await t.repository.list(compositeOwner)).map((record) => record.id),
    ).toEqual([t.bound.id]);
    expect(await workflows.load(compositeOwner, legacy.id)).toEqual(legacy);
    expect(await readFile(await t.f.storage.path(legacy.id))).toEqual(bytes);
    await t.repository.discard(compositeOwner, t.bound.id, t.guard);
    expect(await workflows.load(compositeOwner, legacy.id)).toEqual(legacy);
  } finally {
    await t.f.close();
  }
});
