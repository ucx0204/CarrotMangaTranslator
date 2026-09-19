import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpWorkflowOutputs } from "../src/shared/mcpWorkflow";

type Fixture = Awaited<ReturnType<typeof retentionFixture>>;

async function prepare(f: Fixture) {
  const chapter = await f.snapshot();
  const result = await f.invoke("carrot_prepare_workflow", {
    requestId: randomUUID(),
    reason: "Isolated native owner-index publication",
    chapters: [{
      chapterId: chapter.id,
      pages: chapter.pages.map((page) => ({
        pageId: page.id,
        revision: createPageRevision(page),
      })),
    }],
    stages: [{ kind: "export-png" }],
  });
  return mcpWorkflowOutputs.carrot_prepare_workflow.parse(result.structuredContent);
}

async function publish(
  f: Fixture,
  id: string,
  value: unknown,
  owner: { expected: string; next: string },
  beforeCommit: () => void = () => {},
  guard: () => void = () => {},
) {
  const { withLibraryMutation } = await import("../src/main/library/lock");
  const { runLibraryTransaction } = await import("../src/main/libraryStore/libraryTransaction");
  return withLibraryMutation(() => runLibraryTransaction(
    "isolated-workflow-owner-storage",
    async (transaction) => {
      await f.storage.stageRecord(transaction, id, value, owner);
      beforeCommit();
    },
    undefined,
    guard,
  ));
}

async function bytes(f: Fixture, id: string) {
  return Promise.all([
    readFile(await f.storage.path()),
    readFile(await f.storage.path(id)),
    readFile(f.chapterPath),
  ]);
}

it("publishes the workflow record and index owner together without moving page history", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("retained history stays with its initiating owner");
    const history = (await f.list()).items[0].id;
    const plan = await prepare(f);
    const { McpWorkflowRecordSchema } = await import("../src/main/application/mcpWorkflowPolicy");
    const record = McpWorkflowRecordSchema.parse(await f.storage.record(plan.id));
    const originalPage = await readFile(f.chapterPath);
    const next = { ...record, owner: "receiving-connection", version: record.version + 1 };
    await publish(f, plan.id, next, { expected: f.owner, next: next.owner });
    await f.restart();
    await expect(f.invoke("carrot_get_workflow", { id: plan.id })).rejects.toThrow();
    const received = await f.invoke("carrot_get_workflow", { id: plan.id }, f.auth(next.owner));
    expect(received.structuredContent).toMatchObject({ id: plan.id, version: next.version });
    expect(await f.storage.record(plan.id)).toEqual(next);
    const index = await f.storage.index();
    expect(index.entries.find((entry) => entry.id === plan.id)).toMatchObject({
      owner: next.owner, requestId: null, kind: "workflow",
    });
    expect(index.entries.find((entry) => entry.id === history)?.owner).toBe(f.owner);
    expect(await readFile(f.chapterPath)).toEqual(originalPage);
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects owner-index transitions for retained page history", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("never transfer history with a workflow option");
    const id = (await f.list()).items[0].id;
    const original = await bytes(f, id);
    await expect(publish(f, id, { owner: "recipient" }, {
      expected: f.owner, next: "recipient",
    })).rejects.toThrow("Workflow owner changed");
    expect(await bytes(f, id)).toEqual(original);
  } finally {
    await f.close();
  }
});

it("rejects stale owners and inconsistent record owners without publishing either file", async () => {
  const f = await retentionFixture();
  try {
    const plan = await prepare(f);
    const record = await f.storage.record(plan.id);
    const original = await bytes(f, plan.id);
    for (const transition of [
      { expected: "unrelated", next: "recipient" },
      { expected: f.owner, next: "recipient" },
      { expected: f.owner, next: "../invalid" },
    ]) {
      await expect(publish(f, plan.id, record, transition)).rejects.toThrow();
      expect(await bytes(f, plan.id)).toEqual(original);
    }
  } finally {
    await f.close();
  }
});

it("rolls back encrypted staging when authorization is revoked before publication", async () => {
  const f = await retentionFixture();
  try {
    const plan = await prepare(f);
    const { McpWorkflowRecordSchema } = await import("../src/main/application/mcpWorkflowPolicy");
    const record = McpWorkflowRecordSchema.parse(await f.storage.record(plan.id));
    const original = await bytes(f, plan.id);
    let authorized = true;
    await expect(publish(
      f,
      plan.id,
      { ...record, owner: "recipient", version: record.version + 1 },
      { expected: f.owner, next: "recipient" },
      () => { authorized = false; },
      () => { if (!authorized) throw new Error("approved handoff revoked"); },
    )).rejects.toThrow("approved handoff revoked");
    expect(await bytes(f, plan.id)).toEqual(original);
    await f.restart();
    expect((await f.invoke("carrot_get_workflow", { id: plan.id })).structuredContent)
      .toMatchObject({ id: plan.id, version: record.version });
  } finally {
    await f.close();
  }
});
