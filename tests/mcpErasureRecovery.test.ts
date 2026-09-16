import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { McpErasureRecoveryService } from "../src/main/application/mcpErasureRecoveryService";
import { createMcpErasureRecoveryTools } from "../src/main/mcp/mcpErasureRecoveryTools";
import { mcpErasureRecoveryOutputs } from "../src/shared/mcpErasureRecoverySchemas";
import type { PageRevision } from "../src/shared/pageRevisionTypes";

type Ports = ConstructorParameters<typeof McpErasureRecoveryService>[0];
const after = "page-v1:1111111111111111" as PageRevision;
const before = "page-v1:0000000000000000" as PageRevision;
function fixture() {
  let state: "applied" | "undone" = "applied";
  const jobId = randomUUID();
  const owner = "connection-a";
  const target = { chapterId: "chapter", pageId: "page", blockId: "block" };
  const job = { kind: "erase", status: "completed", target, result: { pagesChanged: 1, blocksErased: 1, cleanupFailed: false } };
  const ports: Ports = {
    readJob: vi.fn(async (id, who) => { if (id !== jobId || who !== owner) throw new Error("not found"); return job; }),
    inspect: vi.fn(async () => ({ state, reason: "ready", revision: state === "applied" ? after : before })),
    apply: vi.fn(async (_id, _target, direction, _revision, guard) => { guard(); state = direction === "undo" ? "undone" : "applied"; return { revision: state === "applied" ? after : before }; }),
    withPageEdit: vi.fn(async (_target, guard, execute) => { guard(); return execute(guard); }),
    notifySaved: vi.fn(),
  };
  const service = new McpErasureRecoveryService(ports);
  service.remember(jobId, "private-native-reference");
  const authorize = vi.fn();
  const action = { jobId, requestId: randomUUID(), revision: after, direction: "undo" as const };
  return { service, ports, job, jobId, owner, authorize, action };
}

describe("owned selected-erasure recovery", () => {
  it("inspects without mutation and replays undo/redo with separate request IDs", async () => {
    const f = fixture();
    expect(await f.service.inspect(f.jobId, f.owner, f.authorize)).toMatchObject({ canUndo: true, canRedo: false });
    expect(f.ports.apply).not.toHaveBeenCalled();
    const undo = await f.service.apply(f.action, f.owner, f.authorize);
    expect(undo).toMatchObject({ status: "applied", pagesChanged: 1, revision: before });
    expect(await f.service.inspect(f.jobId, f.owner, f.authorize)).toMatchObject({ canUndo: false, canRedo: true });
    await f.service.apply({ ...f.action, requestId: randomUUID(), revision: before, direction: "redo" }, f.owner, f.authorize);
    expect(await f.service.inspect(f.jobId, f.owner, f.authorize)).toMatchObject({ canUndo: true });
    expect(f.ports.apply).toHaveBeenCalledTimes(2);
    await f.service.close();
  });
  it("coalesces simultaneous exact retries and never repeats an old undo after redo", async () => {
    const f = fixture();
    const results = await Promise.all([f.service.apply(f.action, f.owner, f.authorize), f.service.apply(f.action, f.owner, f.authorize)]);
    expect(results.map((r) => r.pagesChanged)).toEqual([1, 0]);
    await f.service.apply({ ...f.action, requestId: randomUUID(), revision: before, direction: "redo" }, f.owner, f.authorize);
    expect(await f.service.apply(f.action, f.owner, f.authorize)).toMatchObject({ status: "already_applied", pagesChanged: 0, revision: before });
    expect(await f.service.inspect(f.jobId, f.owner, f.authorize)).toMatchObject({ state: "applied" });
    await expect(f.service.apply({ ...f.action, direction: "redo" }, f.owner, f.authorize)).rejects.toMatchObject({ code: "invalid_edit" });
    expect(f.ports.apply).toHaveBeenCalledTimes(2);
    await f.service.close();
  });
  it("checks ownership on inspect, actions and cached receipts", async () => {
    const f = fixture();
    await f.service.apply(f.action, f.owner, f.authorize);
    await expect(f.service.inspect(f.jobId, "other", f.authorize)).rejects.toThrow("not found");
    await expect(f.service.apply(f.action, "other", f.authorize)).rejects.toThrow("not found");
    expect(f.ports.apply).toHaveBeenCalledTimes(1);
    await f.service.close();
  });
  it.each(["running", "failed", "cancelled", "partial", "interrupted"])("does not recover a %s job", async (status) => {
    const f = fixture(); f.job.status = status;
    expect(await f.service.inspect(f.jobId, f.owner, f.authorize)).toMatchObject({ reason: "job_not_completed", canUndo: false, canRedo: false });
    await expect(f.service.apply(f.action, f.owner, f.authorize)).rejects.toThrow();
    expect(f.ports.apply).not.toHaveBeenCalled(); await f.service.close();
  });
  it("does not recover page-wide, other-kind, no-op or cleanup-failed work", async () => {
    const f = fixture();
    f.job.target.blockId = "";
    expect(await f.service.inspect(f.jobId, f.owner, f.authorize)).toMatchObject({ reason: "not_selected_erasure" });
    f.job.target.blockId = "block"; f.job.result.cleanupFailed = true;
    expect(await f.service.inspect(f.jobId, f.owner, f.authorize)).toMatchObject({ reason: "job_not_completed" });
    f.job.result.cleanupFailed = false; f.job.result.pagesChanged = 0;
    expect(await f.service.inspect(f.jobId, f.owner, f.authorize)).toMatchObject({ reason: "job_not_completed" });
    f.job.kind = "ocr";
    await expect(f.service.apply(f.action, f.owner, f.authorize)).rejects.toMatchObject({ code: "invalid_edit" });
    await f.service.close();
  });
  it("requires a session history association, including after restart", async () => {
    const f = fixture();
    const restarted = new McpErasureRecoveryService(f.ports);
    expect(await restarted.inspect(f.jobId, f.owner, f.authorize)).toMatchObject({ reason: "history_unavailable" });
    await restarted.close(); await f.service.close();
  });
  it("rechecks authority and state after the page handoff", async () => {
    const f = fixture();
    vi.mocked(f.ports.withPageEdit).mockImplementation(async (_target, guard, execute) => {
      f.authorize.mockImplementation(() => { throw new Error("revoked"); });
      return execute(guard);
    });
    await expect(f.service.apply(f.action, f.owner, f.authorize)).rejects.toThrow("revoked");
    expect(f.ports.apply).not.toHaveBeenCalled(); await f.service.close();
  });
  it("retains a failed action and stops deferred actions without releasing native history", async () => {
    const f = fixture();
    vi.mocked(f.ports.notifySaved).mockImplementation(() => { throw new Error("after commit"); });
    await expect(f.service.apply(f.action, f.owner, f.authorize)).rejects.toThrow("after commit");
    await expect(f.service.apply(f.action, f.owner, f.authorize)).rejects.toThrow("after commit");
    expect(f.ports.apply).toHaveBeenCalledTimes(1);
    await f.service.close(); f.service.remember("ignored", "ignored");
    await expect(f.service.inspect(f.jobId, f.owner, f.authorize)).rejects.toMatchObject({ code: "access_denied" });
  });
});

it("exposes strict, scoped, metadata-only tools with validated output contracts", async () => {
  const f = fixture();
  const tools = createMcpErasureRecoveryTools(f.service);
  const context = { principalId: f.owner, assertAuthorized: f.authorize, assertScopes: vi.fn() };
  for (const tool of tools) {
    await expect(tool.invoke({ jobId: f.jobId, transactionId: "injected" }, context)).rejects.toThrow();
    await expect(tool.invoke({ jobId: f.jobId, revision: after, requestId: randomUUID() }, undefined)).rejects.toThrow();
  }
  const lookup = tools[0];
  const result = await lookup.invoke({ jobId: f.jobId }, context);
  expect(result).toHaveLength(1);
  expect(result[0].type).toBe("text");
  if (result[0].type !== "text") throw new Error("Expected metadata");
  expect(mcpErasureRecoveryOutputs.carrot_get_erasure_recovery.safeParse(JSON.parse(result[0].text)).success).toBe(true);
  expect(result[0].text).not.toMatch(/private-native|resource_link|image\/|url/);
  const denied = { ...context, assertScopes: () => { throw new Error("scope denied"); } };
  await expect(tools[1].invoke({ jobId: f.jobId, revision: after, requestId: randomUUID() }, denied)).rejects.toThrow("scope denied");
  await f.service.close();
});
