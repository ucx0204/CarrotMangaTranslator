import { createMcpServerInfoTool } from "../src/main/mcp/mcpServerInfoTool";
import { mcpToolOutputSchema } from "../src/main/mcp/mcpOutputSchemas";
import { expect, it, vi } from "vitest";
import { handleMcpMessage } from "../src/main/mcp/mcpProtocol";
import {
  describeMcpTool,
  textContent,
  type McpTool,
} from "../src/main/mcp/mcpReadTools";
import { mcpOutputSchemas } from "../src/main/mcp/mcpOutputSchemas";
import { mcpToolResult } from "../src/main/mcp/mcpToolResult";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { createMcpOperationTools } from "../src/main/mcp/mcpOperationTools";

const data = { total: 0, offset: 0, limit: 20, nextOffset: null, works: [] };
function tool(value: unknown = data): McpTool {
  return {
    name: "carrot_list_works",
    description: "fixture",
    inputSchema: {},
    invoke: async () => textContent(value),
  };
}
async function call(t: McpTool) {
  const report = vi.fn();
  const result = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: t.name, arguments: {} },
    },
    [t],
    report,
  );
  return {
    body: result.body as {
      result: {
        content: unknown[];
        structuredContent: unknown;
        isError: boolean;
      };
    },
    report,
  };
}
it("publishes real 2020-12 output schemas for every existing tool, cached from runtime contracts", () => {
  expect(Object.keys(mcpOutputSchemas)).toHaveLength(19);
  for (const name of Object.keys(mcpOutputSchemas)) {
    const schema = mcpToolOutputSchema(name);
    expect(schema).toMatchObject({
      type: "object",
      $schema: "https://json-schema.org/draft/2020-12/schema",
    });
    expect(schema).toBe(mcpToolOutputSchema(name));
  }
  expect(mcpToolOutputSchema("unregistered-fixture")).toBeUndefined();
});
it("returns the same validated metadata in structuredContent and readable text", async () => {
  const { body, report } = await call(tool());
  expect(body.result).toEqual({
    content: textContent(data),
    structuredContent: data,
    isError: false,
  });
  expect(report).not.toHaveBeenCalled();
});
it.each([
  { ...data, total: "wrong" },
  { ...data, internalPath: "C:/private" },
])(
  "fails closed on an invalid public result without echoing the invalid fields",
  async (value) => {
    const { body, report } = await call(tool(value));
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toMatchObject({
      error: "operation_failed",
      retryable: false,
    });
    expect(JSON.stringify(body)).not.toContain("C:/private");
    expect(report).toHaveBeenCalledOnce();
  },
);
it("preserves image content beside structured image metadata", () => {
  const metadata = {
    pageId: "page",
    updatedAt: "now",
    sourceWidth: 10,
    sourceHeight: 20,
    previewWidth: 5,
    previewHeight: 10,
  };
  const content = [
    ...textContent(metadata),
    { type: "image" as const, data: "png", mimeType: "image/png" as const },
  ];
  expect(
    mcpToolResult({ ...tool(), name: "carrot_get_page_preview" }, content),
  ).toMatchObject({
    content,
    structuredContent: metadata,
  });
  expect(() => mcpToolResult(tool(), content.slice(1))).toThrow(/metadata/);
});
it("returns actionable typed failures without treating a conflict as a successful edit", async () => {
  const t = tool();
  t.invoke = async () => {
    throw new McpEditError("revision_conflict", "Read again.");
  };
  const { body, report } = await call(t);
  expect(body.result.structuredContent).toMatchObject({
    error: "revision_conflict",
    retryable: false,
    nextAction: expect.stringContaining("Read the current page"),
  });
  expect(report).not.toHaveBeenCalled();
});
it("describes cancellation, OCR, removal and export independently", () => {
  const service = new McpOperationService(() => {});
  const tools = createMcpOperationTools(service, {
    ocr: async () => ({}),
    erase: async () => ({}),
    exportPng: async () => ({}),
  });
  const descriptions = Object.fromEntries(
    tools.map((t) => [t.name, describeMcpTool(t)]),
  );
  expect(descriptions.carrot_cancel_job.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  });
  expect(descriptions.carrot_run_page_ocr.annotations).toMatchObject({
    destructiveHint: false,
    openWorldHint: true,
  });
  expect(descriptions.carrot_run_page_erasure.annotations).toMatchObject({
    destructiveHint: true,
    openWorldHint: true,
  });
  expect(descriptions.carrot_export_page_png.annotations).toMatchObject({
    readOnlyHint: true,
    openWorldHint: false,
  });
});

it("returns schema-validated server identity without disclosing paths or authorizing a copied data profile", async () => {
  const info = {
    serverId: "a".repeat(64),
    dataProfileId: "b".repeat(64),
    runtimeId: "11111111-1111-4111-8111-111111111111",
    startedAt: 1000,
    appVersion: "2.7.7",
    resource: "https://carrot.test.ts.net/mcp",
    mode: "development" as const,
  };
  const tool = createMcpServerInfoTool(info);
  const reply = mcpToolResult(tool, await tool.invoke({}));
  expect(reply.isError).toBe(false);
  expect(reply.structuredContent).toMatchObject({
    ...info,
    protocolVersion: "2026-07-28",
    autoTransferAuthorization: false,
    authorizationStorage: "os-encrypted-app-data-root",
  });
  expect(JSON.stringify(reply)).not.toContain("localToken");
  await expect(tool.invoke({ path: "C:/private" })).rejects.toThrow();
});
