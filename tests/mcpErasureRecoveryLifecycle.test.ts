import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { McpErasureRecoveryService } from "../src/main/application/mcpErasureRecoveryService";
import type { PageRevision } from "../src/shared/pageRevisionTypes";

const applied = "page-v1:1111111111111111" as PageRevision;
const undone = "page-v1:0000000000000000" as PageRevision;
function fixture() {
  const jobId = randomUUID();
  const owner = "connection-a";
  const target = { chapterId: "chapter", pageId: "page", blockId: "block" };
  const ports: ConstructorParameters<typeof McpErasureRecoveryService>[0] = {
    readJob: vi.fn(async (id, principal) => {
      if (id !== jobId || principal !== owner) throw new Error("not found");
      return { kind: "erase", status: "completed", target, result: { pagesChanged: 1, blocksErased: 1 } };
    }),
    inspect: vi.fn(async () => ({ state: "applied", reason: "ready", revision: applied })),
    apply: vi.fn(async (_id, _target, _direction, _revision, guard) => {
      guard();
      return { revision: undone };
    }),
    withPageEdit: async (_target, guard, execute) => execute(guard),
    notifySaved: vi.fn(),
  };
  const service = new McpErasureRecoveryService(ports);
  service.remember(jobId, "native-history");
  const action = { jobId, requestId: randomUUID(), revision: applied, direction: "undo" as const };
  return { ports, service, jobId, owner, action };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("recovery lifetime and receipt safety", () => {
  it("rechecks the page after handoff rather than trusting advisory availability", async () => {
    const f = fixture();
    f.ports.withPageEdit = async (_target, guard, execute) => {
      vi.mocked(f.ports.inspect).mockResolvedValue({ state: "conflict", reason: "page_changed", revision: undone });
      return execute(guard);
    };
    try {
      await expect(f.service.apply(f.action, f.owner, () => {})).rejects.toMatchObject({ code: "revision_conflict" });
      expect(f.ports.apply).not.toHaveBeenCalled();
      expect(f.ports.notifySaved).not.toHaveBeenCalled();
    } finally { await f.service.close(); }
  });

  it("waits for a pending handoff on close and prevents its later commit", async () => {
    const f = fixture();
    const entered = deferred();
    const finish = deferred();
    f.ports.withPageEdit = async (_target, guard, execute) => {
      entered.resolve();
      await finish.promise;
      return execute(guard);
    };
    const pending = f.service.apply(f.action, f.owner, () => {});
    const rejected = expect(pending).rejects.toMatchObject({ code: "access_denied" });
    await entered.promise;
    let closed = false;
    const closing = f.service.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish.resolve();
    await rejected;
    await closing;
    expect(f.ports.apply).not.toHaveBeenCalled();
    expect(closed).toBe(true);
  });

  it("does not disclose cached receipts after revocation or share mutable receipt data", async () => {
    const f = fixture();
    try {
      const receipt = await f.service.apply(f.action, f.owner, () => {});
      receipt.target.pageId = "changed-by-client";
      const repeated = await f.service.apply(f.action, f.owner, () => {});
      expect(repeated.target.pageId).toBe("page");
      expect(repeated.pagesChanged).toBe(0);
      await expect(f.service.apply(f.action, f.owner, () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
      expect(f.ports.apply).toHaveBeenCalledTimes(1);
    } finally { await f.service.close(); }
  });

  it("never rebinds a known job and expires the oldest association at its bound", async () => {
    const f = fixture();
    try {
      f.service.remember(f.jobId, "replacement-must-not-bind");
      await f.service.inspect(f.jobId, f.owner, () => {});
      expect(f.ports.inspect).toHaveBeenCalledWith("native-history", expect.objectContaining({ pageId: "page" }));
      for (let index = 0; index < 512; index++) f.service.remember(randomUUID(), `history-${index}`);
      expect(await f.service.inspect(f.jobId, f.owner, () => {})).toMatchObject({ state: "unavailable", reason: "history_unavailable" });
      expect(f.ports.apply).not.toHaveBeenCalled();
    } finally { await f.service.close(); }
  });

  it("bounds action receipts without evicting a retry and accidentally applying it again", async () => {
    const f = fixture();
    try {
      for (let index = 0; index < 512; index++) {
        const invalid = { ...f.action, requestId: randomUUID(), revision: undone };
        await expect(f.service.apply(invalid, f.owner, () => {})).rejects.toMatchObject({ code: "revision_conflict" });
      }
      await expect(f.service.apply(f.action, f.owner, () => {})).rejects.toMatchObject({ code: "invalid_edit" });
      expect(f.ports.apply).not.toHaveBeenCalled();
    } finally { await f.service.close(); }
  });
});
