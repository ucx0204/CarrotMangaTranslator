import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";
import type { BubbleLayoutRunner } from "../src/main/inpainting/bubbleLayoutRunner";
import { McpLetteringPrepareSchema } from "../src/shared/mcpLettering";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";

export async function letteringAppFixture() {
  const f = await typographyAnalysisAppFixture();
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { createMcpLetteringSession } =
    await import("../src/main/mcp/mcpLetteringSession");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const { createMcpOperationTools } =
    await import("../src/main/mcp/mcpOperationTools");
  const errors: unknown[] = [];
  let journal: unknown = null;
  const persistence = {
    load: async () => structuredClone(journal),
    save: async (value: unknown) => {
      journal = structuredClone(value);
    },
  };
  const operations = new McpOperationService(
    (error) => errors.push(error),
    Date.now,
    persistence,
  );
  const runPage = vi.fn<BubbleLayoutRunner["runPage"]>(async (input) => ({
    patches: (input.targetBlockIds ?? []).map((id) => ({
      blockId: id,
      renderBbox: { x: 100, y: 100, w: 500, h: 700 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: {
        version: 1,
        direction: "horizontal",
        confidence: 0.95,
        origin: "detected",
        modelId: "synthetic-layout",
        sourceImageRevision: "fixture-image",
        insetRatio: 0.05,
        regions: [
          {
            spans: [
              { blockStart: 0, blockEnd: 1, inlineStart: 0, inlineEnd: 1 },
            ],
          },
        ],
      },
    })),
  }));
  const runtime = {
    create: vi.fn(() => ({ runPage })),
    dispose: vi.fn(async () => {}),
  };
  const notifySaved = vi.fn();
  const session = createMcpLetteringSession(
    f.app,
    operations,
    { assertWritable: async () => {}, notifySaved },
    true,
    runtime,
  );
  const tools = [...session.tools, ...createMcpOperationTools(operations, {})];
  const owner = "lettering-owner";
  const auth = (principalId = owner) => ({
    principalId,
    assertAuthorized: vi.fn(),
    assertScopes: vi.fn(),
    assertJobAuthorized: vi.fn(),
  });
  const invoke = async (
    name: string,
    args: Record<string, unknown>,
    principal = owner,
  ) => {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`Missing tool: ${name}`);
    const result = mcpToolResult(
      tool,
      await tool.invoke(args, auth(principal)),
    );
    if (result.isError)
      throw new Error(JSON.stringify(result.structuredContent));
    return result.structuredContent as Record<string, unknown>;
  };
  const request = async (command: unknown) => {
    const saved = await f.library.readWorkContextForEdit("chapter");
    return McpLetteringPrepareSchema.parse({
      chapterId: "chapter",
      contextRevision: mcpContextRevision(saved),
      requestId: randomUUID(),
      reason: "Isolated native lettering",
      command,
      pages: saved.chapter.pages.map((page) => ({
        pageId: page.id,
        revision: createPageRevision(page),
        edits: [
          { blockId: page.blocks[0].id, reason: "Selected dialogue only" },
        ],
      })),
    });
  };
  const settleJob = async (jobId: string, principal = owner) => {
    await vi.waitFor(
      () => expectTerminal(operations.status(jobId, principal).status),
      { timeout: 10000 },
    );
    return operations.status(jobId, principal);
  };
  const prepare = async (command: unknown) => {
    const input = await request(command);
    const receipt = await invoke("carrot_prepare_lettering_batch", input);
    const job = await settleJob(String(receipt.jobId));
    return { input, job, batchId: job.result?.letteringPlan?.batchId };
  };
  const done = async (batchId: string) => {
    await vi.waitFor(
      async () => {
        const result = await invoke("carrot_get_lettering_batch", { batchId });
        expectTerminal(String(result.status));
      },
      { timeout: 10000 },
    );
    return invoke("carrot_get_lettering_batch", { batchId });
  };
  const action = async (
    batchId: string,
    direction: "apply" | "undo" | "redo",
  ) => {
    await invoke(`carrot_${direction}_lettering_batch`, {
      batchId,
      requestId: randomUUID(),
    });
    return done(batchId);
  };
  return {
    ...f,
    operations,
    persistence,
    runtime,
    runPage,
    session,
    tools,
    errors,
    owner,
    auth,
    invoke,
    request,
    settleJob,
    prepare,
    done,
    action,
    notifySaved,
    close: async () => {
      session.stop();
      operations.stop();
      await operations.close();
      await session.close();
      await f.close();
    },
  };
}
function expectTerminal(status: string) {
  if (status === "running") throw new Error("Job still running");
}
