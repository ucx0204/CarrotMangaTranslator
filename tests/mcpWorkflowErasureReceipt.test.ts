import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { createMcpOperationTools } from "../src/main/mcp/mcpOperationTools";
import { McpWorkflowRecordSchema } from "../src/main/application/mcpWorkflowPolicy";
import { workflowErasureCompleted } from "../src/main/mcp/mcpWorkflowReconciliation";

it("requires a conclusive matching erasure receipt after journal reconstruction and never executes to verify it", async () => {
  const f = await workflowFixture();
  let saved: unknown = null;
  const persistence = {
    load: async () => structuredClone(saved),
    save: async (value: unknown) => { saved = structuredClone(value); },
  };
  let manager = new McpOperationService(() => {}, Date.now, persistence);
  const execute = vi.fn(async (target: { revision: string }) => ({
    revision: target.revision, status: "completed", pagesChanged: 1,
    blocksErased: 2, blocksIncomplete: 0,
  }));
  try {
    const before = await readFile(f.chapterPath);
    const plan = await f.prepare([{ kind: "erase", allowAssetDownloads: true }]);
    const record = McpWorkflowRecordSchema.parse(await f.storage.record(plan.id));
    const step = record.steps[0];
    step.attemptId = randomUUID();
    const page = record.pages[0];
    const tool = createMcpOperationTools(manager, { erase: execute }).find((tool) => tool.name === "carrot_run_page_erasure");
    if (!tool) throw new Error("Missing native erasure tool");
    const receipt = await tool.invoke({ chapterId: page.chapterId, pageId: page.pageId, revision: page.revision, requestId: step.attemptId }, f.auth());
    if (receipt[0]?.type !== "text") throw new Error("Expected job receipt");
    step.jobId = JSON.parse(receipt[0].text).jobId;
    if (!step.jobId) throw new Error("Missing native job ID");
    await manager.waitForCompletion(step.jobId, f.owner, new AbortController().signal);
    expect(await workflowErasureCompleted(manager, record, step, () => {})).toBe(true);
    await manager.close();
    manager = new McpOperationService(() => {}, Date.now, persistence);
    expect(await workflowErasureCompleted(manager, record, step, () => {})).toBe(true);
    expect(await workflowErasureCompleted(manager, { ...record, owner: "foreign" }, step, () => {})).toBe(false);
    await expect(workflowErasureCompleted(manager, record, { ...step, attemptId: randomUUID() }, () => {})).rejects.toThrow("different workflow attempt");
    const wrong = structuredClone(record);
    wrong.pages[0].pageId = "different-page";
    await expect(workflowErasureCompleted(manager, wrong, step, () => {})).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await manager.close();
    await f.close();
  }
});

it("does not accept partial, cleanup-failed or missing completion evidence", async () => {
  const f = await workflowFixture();
  const manager = new McpOperationService(() => {});
  try {
    const plan = await f.prepare([{ kind: "erase", allowAssetDownloads: true }]);
    const record = McpWorkflowRecordSchema.parse(await f.storage.record(plan.id));
    const step = record.steps[0], page = record.pages[0];
    expect(await workflowErasureCompleted(manager, record, step, () => {})).toBe(false);
    for (const outcome of [
      { status: "partial", blocksIncomplete: 0 },
      { status: "completed", blocksIncomplete: 1 },
      { status: "completed", blocksIncomplete: 0, cleanupFailed: true },
      { status: "completed" },
    ]) {
      const tool = createMcpOperationTools(manager, { erase: async () => ({ ...outcome, revision: page.revision }) }).find((tool) => tool.name === "carrot_run_page_erasure");
      if (!tool) throw new Error("Missing native erasure tool");
      step.attemptId = randomUUID();
      const receipt = await tool.invoke({ chapterId: page.chapterId, pageId: page.pageId, revision: page.revision, requestId: step.attemptId }, f.auth());
      if (receipt[0]?.type !== "text") throw new Error("Expected job receipt");
      step.jobId = JSON.parse(receipt[0].text).jobId;
      if (!step.jobId) throw new Error("Missing native job ID");
      await manager.waitForCompletion(step.jobId, f.owner, new AbortController().signal);
      expect(await workflowErasureCompleted(manager, record, step, () => {})).toBe(false);
    }
  } finally {
    await manager.close();
    await f.close();
  }
});
