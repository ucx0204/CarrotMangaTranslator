import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  McpOperationService,
  type McpOperationExecutor,
} from "../src/main/application/mcpOperationService";
import { parseMcpJobJournal } from "../src/main/application/mcpJobJournal";
import { createMcpOperationTools } from "../src/main/mcp/mcpOperationTools";
import { mcpToolResult } from "../src/main/mcp/mcpToolResult";
import { hashStableValue } from "../src/shared/blockFingerprint";

function fixture() {
  let disk: unknown = null;
  const persistence = {
    load: async () => structuredClone(disk),
    save: async (value: unknown) => {
      disk = structuredClone(value);
    },
  };
  const service = new McpOperationService(() => {}, Date.now, persistence);
  const check = vi.fn();
  const context = {
    principalId: "test-grant",
    assertAuthorized: check,
    assertScopes: check,
    assertJobAuthorized: check,
  };
  const target = {
    chapterId: "chapter",
    pageId: "page",
    blockId: "selected",
    revision: "page-v1:0000000000000000",
    requestId: randomUUID(),
  };
  return { service, persistence, context, target, saved: () => disk };
}
async function waitSettled(service: McpOperationService, id: string) {
  await vi.waitFor(() =>
    expect(service.status(id, "test-grant").status).not.toBe("running"),
  );
}
it("retains a failed selected-block request through persisted restart and explicit retry", async () => {
  const f = fixture();
  const fail = vi.fn<McpOperationExecutor>(async () => {
    throw new Error("fixture engine unavailable");
  });
  const start = createMcpOperationTools(f.service, { erase: fail }).find(
    (t) => t.name === "carrot_run_page_erasure",
  );
  if (!start) throw new Error("Missing erasure tool");
  const response = mcpToolResult(
    start,
    await start.invoke(f.target, f.context),
  );
  expect(response.isError).toBe(false);
  const receipt = JSON.parse(
    response.content[0].type === "text" ? response.content[0].text : "null",
  );
  expect(receipt.target.blockId).toBe("selected");
  await waitSettled(f.service, receipt.jobId);
  await f.service.close();
  const restored = new McpOperationService(() => {}, Date.now, f.persistence);
  const run = vi.fn<McpOperationExecutor>(async (target) => ({
    status: "completed",
    blockId: target.blockId,
    pagesChanged: 1,
  }));
  try {
    await restored.ready();
    const retry = createMcpOperationTools(restored, { erase: run }).find(
      (t) => t.name === "carrot_retry_job",
    );
    if (!retry) throw new Error("Missing retry tool");
    const content = await retry.invoke(
      {
        jobId: receipt.jobId,
        requestId: randomUUID(),
        revision: f.target.revision,
      },
      f.context,
    );
    const next = JSON.parse(
      content[0].type === "text" ? content[0].text : "null",
    );
    await waitSettled(restored, next.jobId);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: "selected" }),
      expect.anything(),
    );
    expect(parseMcpJobJournal(f.saved())[0].parameters.blockId).toBe(
      "selected",
    );
  } finally {
    await restored.close();
  }
});
it("does not broaden the selected target on retry and keeps legacy page-wide requests unchanged", async () => {
  const f = fixture();
  const execute = vi.fn<McpOperationExecutor>(async () => ({}));
  const start = createMcpOperationTools(f.service, { erase: execute }).find(
    (t) => t.name === "carrot_run_page_erasure",
  );
  if (!start) throw new Error("Missing tool");
  const response = await start.invoke(f.target, f.context);
  const receipt = JSON.parse(
    response[0].type === "text" ? response[0].text : "null",
  );
  await waitSettled(f.service, receipt.jobId);
  await expect(
    start.invoke({ ...f.target, blockId: "another" }, f.context),
  ).rejects.toThrow(/requestId/);
  const { blockId: _blockId, ...pageTarget } = f.target;
  await start.invoke({ ...pageTarget, requestId: randomUUID() }, f.context);
  await f.service.close();
  expect(execute.mock.calls[1][0]).not.toHaveProperty("blockId");
});
it("rejects selector injection into non-erasure operations before dispatch", async () => {
  const f = fixture();
  const run = vi.fn<McpOperationExecutor>(async () => ({}));
  const tools = createMcpOperationTools(f.service, {
    ocr: run,
    exportPng: run,
    erase: run,
  });
  try {
    for (const name of ["carrot_run_page_ocr", "carrot_export_page_png"]) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error("Missing tool");
      await expect(tool.invoke(f.target, f.context)).rejects.toThrow();
    }
    const erase = tools.find((t) => t.name === "carrot_run_page_erasure");
    if (!erase) throw new Error("Missing tool");
    for (const blockId of ["", "../private", null, ["selected"]])
      await expect(
        erase.invoke({ ...f.target, blockId }, f.context),
      ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  } finally {
    await f.service.close();
  }
});
it("fails closed if a persisted non-erasure job acquires a selector", async () => {
  const f = fixture();
  const { blockId: _blockId, ...target } = f.target;
  const receipt = await f.service.start({
    owner: "test-grant",
    requestId: target.requestId,
    kind: "ocr",
    parameters: target,
    assertAuthorized: () => {},
    execute: async () => ({}),
  });
  await waitSettled(f.service, receipt.jobId);
  await f.service.close();
  const stored = parseMcpJobJournal(f.saved());
  stored[0].parameters.blockId = "injected";
  stored[0].fingerprint = hashStableValue([
    stored[0].kind,
    stored[0].parameters,
  ]);
  expect(() => parseMcpJobJournal({ version: 1, records: stored })).toThrow(
    /inconsistent/,
  );
});
