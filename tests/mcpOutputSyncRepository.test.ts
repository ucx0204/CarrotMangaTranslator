import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import {
  syncOwner,
  syncReview,
  syncRequest,
  syncIntents,
  syncEffect,
} from "./mcpOutputSync.fixture";

async function setup() {
  const f = await retentionFixture();
  const { McpOutputSyncRepository } =
    await import("../src/main/mcp/mcpOutputSyncRepository");
  const repository = new McpOutputSyncRepository(f.storage);
  const review = syncReview();
  const request = syncRequest(review);
  const guard = () => undefined;
  const begin = () =>
    repository.begin(
      syncOwner,
      { request, jobId: randomUUID() },
      review,
      guard,
    );
  return {
    f,
    repository,
    review,
    request,
    guard,
    begin,
    restart: () => new McpOutputSyncRepository(f.storage),
  };
}

it("atomically deduplicates owner/request admission without exposing private allocations", async () => {
  const t = await setup();
  try {
    const results = await Promise.all([t.begin(), t.begin()]);
    expect(results[0].id).toBe(results[1].id);
    expect(results.filter((result) => !result.historical)).toHaveLength(1);
    const session = results.find((result) => result.session)?.session;
    if (!session) throw new Error("Missing admitted session.");
    const intent = syncIntents()[0];
    const settlement = await session.recordIntent(intent, t.guard);
    const raw = await readFile(await t.f.storage.path(results[0].id), "utf8");
    expect(raw).not.toContain(intent.relativePath);
    const publicReceipt = await t.repository.inspect(
      syncOwner,
      { id: results[0].id },
      t.guard,
    );
    expect(publicReceipt.publicationUnconfirmed).toBe(1);
    expect(JSON.stringify(publicReceipt)).not.toContain("relativePath");
    expect(JSON.stringify(publicReceipt)).not.toContain(intent.relativePath);
    await settlement.settle(syncEffect(intent));
    await session.fail("publication_failed", false);
    await expect(
      t.repository.inspect("another-owner", { id: results[0].id }, t.guard),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await t.repository.find("another-owner", t.request, t.guard),
    ).toBeUndefined();
    await expect(
      t.repository.find(
        syncOwner,
        { ...t.request, sourceSnapshot: "0".repeat(16) },
        t.guard,
      ),
    ).rejects.toMatchObject({ code: "invalid_edit" });
  } finally {
    await t.f.close();
  }
});

it("persists exact all-role bytes and returns historical completion after reconstruction", async () => {
  const t = await setup();
  try {
    const started = await t.begin();
    if (!started.session) throw new Error("Missing session.");
    for (const intent of syncIntents()) {
      const settlement = await started.session.recordIntent(intent, t.guard);
      await settlement.settle(syncEffect(intent));
    }
    const current = await t.repository.inspect(
      syncOwner,
      { id: started.id },
      t.guard,
    );
    const receipt = await started.session.finish({
      status: "completed",
      errorCode: null,
      files: current.files,
      publishedBytes: 24,
      metadata: "published",
      mirror: "published",
    });
    expect(receipt).toMatchObject({
      status: "completed",
      publishedBytes: 24,
      reportedPublishedBytes: 24,
      publicationUnconfirmed: 0,
    });
    expect(t.repository.isActive(started.id)).toBe(false);
    const record = await t.f.storage.record(started.id);
    expect(record).toMatchObject({ request: t.request, review: t.review });
    const restarted = t.restart();
    const found = await restarted.find(syncOwner, t.request, t.guard);
    expect(found).toMatchObject({
      id: started.id,
      status: "completed",
      historical: true,
      publishedBytes: 24,
    });
    const retry = await restarted.begin(
      syncOwner,
      { request: t.request, jobId: randomUUID() },
      { ...t.review, sourceSnapshot: "0".repeat(16) },
      t.guard,
    );
    expect(retry).toMatchObject({ id: started.id, historical: true });
    expect(retry.session).toBeUndefined();
    const evidence = await restarted.inspectEvidenceInput(
      syncOwner,
      started.id,
      t.guard,
    );
    expect(evidence.targets).toEqual(syncIntents());
  } finally {
    await t.f.close();
  }
});

it("blocks a revoked pre-effect admission at commit and still settles an already admitted effect", async () => {
  const t = await setup();
  const cancellation = new AbortController();
  const guard = () => cancellation.signal.throwIfAborted();
  try {
    const first = await t.begin();
    if (!first.session) throw new Error("Missing session.");
    const intent = syncIntents()[0];
    const admitted = await first.session.recordIntent(intent, guard);
    cancellation.abort(new Error("permission revoked"));
    await admitted.settle(syncEffect(intent));
    await expect(
      first.session.recordIntent(syncIntents()[1], guard),
    ).rejects.toThrow("permission revoked");
    const receipt = await first.session.fail("publication_failed", true);
    expect(receipt).toMatchObject({
      status: "cancelled",
      publishedBytes: 9,
      publicationUnconfirmed: 0,
    });
    expect(
      receipt.files.find((file) => file.fileId === intent.fileId)?.state,
    ).toBe("published");
  } finally {
    await t.f.close();
  }
});

it("rolls back an admission when authorization disappears after record staging", async () => {
  const t = await setup();
  let allowed = true;
  const guard = () => {
    if (!allowed) throw new Error("revoked at publication");
  };
  const original = t.f.storage.stageRecord.bind(t.f.storage);
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const started = await t.begin();
    if (!started.session) throw new Error("Missing session.");
    spy = vi
      .spyOn(t.f.storage, "stageRecord")
      .mockImplementation(async (...args) => {
        await original(...args);
        allowed = false;
      });
    await expect(
      started.session.recordIntent(syncIntents()[0], guard),
    ).rejects.toThrow("revoked at publication");
    spy.mockRestore();
    expect(await t.f.storage.record(started.id)).toMatchObject({
      admissions: [],
    });
    const receipt = await started.session.fail("publication_failed", true);
    expect(receipt).toMatchObject({
      status: "cancelled",
      publishedBytes: 0,
      publicationUnconfirmed: 0,
    });
  } finally {
    spy?.mockRestore();
    await t.f.close();
  }
});

it("reconstructs an unfinished admitted write as unconfirmed and never reissues its session", async () => {
  const t = await setup();
  try {
    const started = await t.begin();
    if (!started.session) throw new Error("Missing session.");
    await started.session.recordIntent(syncIntents()[0], t.guard);
    const restarted = t.restart();
    const receipt = await restarted.inspect(
      syncOwner,
      { requestId: t.request.requestId },
      t.guard,
    );
    expect(receipt).toMatchObject({
      status: "interrupted",
      publicationUnconfirmed: 1,
      publishedBytes: 0,
    });
    expect(receipt.files[0].state).toBe("publication_unconfirmed");
    const replay = await restarted.begin(
      syncOwner,
      { request: t.request, jobId: randomUUID() },
      t.review,
      t.guard,
    );
    expect(replay.session).toBeUndefined();
    expect(replay.receipt.status).toBe("interrupted");
  } finally {
    await t.f.close();
  }
});

for (const point of ["before-commit-point", "after-commit-point"] as const) {
  it(`recovers the encrypted intent/effect boundary after ${point}`, async () => {
    const t = await setup();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const recovery =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let restore = () => {};
    try {
      const started = await t.begin();
      if (!started.session) throw new Error("Missing session.");
      const intent = syncIntents()[0];
      const settlement = await started.session.recordIntent(intent, t.guard);
      restore = tx.setLibraryTransactionCrashInjectorForTests((position) => {
        if (position === point)
          throw new tx.SimulatedLibraryTransactionCrash(position);
      });
      await expect(settlement.settle(syncEffect(intent))).rejects.toThrow();
      restore();
      await recovery.recoverLibraryTransactions();
      const receipt = await t
        .restart()
        .inspect(syncOwner, { id: started.id }, t.guard);
      expect(receipt.files[0].state).toBe(
        point === "after-commit-point"
          ? "published"
          : "publication_unconfirmed",
      );
      expect(receipt.publishedBytes).toBe(
        point === "after-commit-point" ? 9 : 0,
      );
      expect(receipt.status).toBe("interrupted");
    } finally {
      restore();
      await t.f.close();
    }
  });
}

it("pins an expired active receipt through settlement without extending read or write authority", async () => {
  const t = await setup();
  const { McpRetentionStorage } =
    await import("../src/main/mcp/mcpRetentionStorage");
  const { McpOutputSyncRepository } =
    await import("../src/main/mcp/mcpOutputSyncRepository");
  const { withLibraryMutation } = await import("../src/main/library/lock");
  const { runLibraryTransaction } =
    await import("../src/main/libraryStore/libraryTransaction");
  let now = Date.now();
  const storage = new McpRetentionStorage(
    t.f.codec,
    () => now,
    (id) => repository.isActive(id),
  );
  const repository: InstanceType<typeof McpOutputSyncRepository> =
    new McpOutputSyncRepository(storage);
  const prune = () =>
    withLibraryMutation(() =>
      runLibraryTransaction("test-output-sync-prune", async (transaction) => {
        const index = await storage.prune(transaction, await storage.index());
        await storage.stageIndex(transaction, index);
      }),
    );
  try {
    const started = await repository.begin(
      syncOwner,
      { request: t.request, jobId: randomUUID() },
      t.review,
      t.guard,
    );
    if (!started.session) throw new Error("Missing session.");
    const intent = syncIntents()[0];
    const settlement = await started.session.recordIntent(intent, t.guard);
    now = started.receipt.expiresAt;
    await prune();
    expect(
      (await storage.index()).entries.some((entry) => entry.id === started.id),
    ).toBe(true);
    await expect(
      repository.inspect(syncOwner, { id: started.id }, t.guard),
    ).rejects.toMatchObject({ code: "not_found" });
    await settlement.settle(syncEffect(intent, now));
    await expect(
      started.session.recordIntent(syncIntents()[1], t.guard),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await started.session.fail("publication_failed", true),
    ).toMatchObject({ publishedBytes: 9, status: "cancelled" });
    await prune();
    expect(
      (await storage.index()).entries.some((entry) => entry.id === started.id),
    ).toBe(false);
  } finally {
    await t.f.close();
  }
});
