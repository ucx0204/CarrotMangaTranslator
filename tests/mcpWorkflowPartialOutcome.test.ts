import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { createMcpOperationTools } from "../src/main/mcp/mcpOperationTools";
import { McpWorkflowCalls } from "../src/main/mcp/mcpWorkflowCalls";
import { workflowFixture } from "./mcpWorkflow.fixture";

for (const status of ["partial", "failed", "cancelled", "completed"] as const) {
  it(`does not promote a native ${status} result with unfinished blocks to workflow completion`, async () => {
    const manager = new McpOperationService(() => {});
    const execute = vi.fn(async (target: { revision: string }) => ({
      revision: target.revision, status, pagesChanged: 1,
      blocksErased: 1, blocksIncomplete: status === "completed" ? 1 : 0,
    }));
    const calls = new McpWorkflowCalls(
      createMcpOperationTools(manager, { erase: execute }), manager, "owner", () => {},
    );
    let id = "";
    try {
      await expect(calls.job("carrot_run_page_erasure", {
        chapterId: "chapter", pageId: "page",
        revision: "page-v1:0000000000000000", requestId: randomUUID(),
      }, new AbortController().signal, async (jobId) => { id = jobId; })).rejects.toThrow("incomplete");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(manager.status(id, "owner").result).toMatchObject({ status, pagesChanged: 1 });
    } finally {
      await manager.close();
    }
  });
}

it("accepts a fully completed child once and retains its exact saved revision", async () => {
  const manager = new McpOperationService(() => {});
  const execute = vi.fn(async (target: { revision: string }) => ({
    revision: target.revision, status: "completed", pagesChanged: 1,
    blocksErased: 2, blocksIncomplete: 0,
  }));
  const calls = new McpWorkflowCalls(createMcpOperationTools(manager, { erase: execute }), manager, "owner", () => {});
  try {
    const input = { chapterId: "chapter", pageId: "page", revision: "page-v1:0000000000000000", requestId: randomUUID() };
    for (let n = 0; n < 2; n++)
      expect(await calls.job("carrot_run_page_erasure", input, new AbortController().signal, async () => {})).toMatchObject({
        revision: input.revision, status: "completed", blocksIncomplete: 0,
      });
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    await manager.close();
  }
});

it("never infers full erasure completion from an uncertain native save receipt alone", async () => {
  const f = await workflowFixture();
  const { McpWorkflowRecordSchema } = await import("../src/main/application/mcpWorkflowPolicy");
  const { reconcileNativeWorkflow } = await import("../src/main/mcp/mcpWorkflowReconciliation");
  try {
    const prepared = await f.prepare([{ kind: "erase", allowAssetDownloads: true }]);
    const record = McpWorkflowRecordSchema.parse(await f.storage.record(prepared.id));
    record.steps[0].attemptId = randomUUID();
    expect(await reconcileNativeWorkflow(f.storage, record, record.steps[0], () => {})).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
