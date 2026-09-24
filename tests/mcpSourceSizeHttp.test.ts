import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { createMcpOperationTools } from "../src/main/mcp/mcpOperationTools";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { McpOAuthSession } from "../src/main/mcp/mcpOAuthSession";
import { McpOAuthHttp } from "../src/main/mcp/mcpOAuthHttp";
import { McpPairingBroker } from "../src/main/mcp/mcpPairingBroker";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

it("enforces processing scope and exposes source evidence over HTTP without images or attachments", async () => {
  const origin = "https://source-size.tail-test.ts.net",
    secret = "p".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    persistent: true,
    allowProcessing: true,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const grant = createMcpTestGrant(origin, secret);
  const reader = grant(provider, "carrot.read");
  const processor = grant(provider, "carrot.read carrot.process");
  const operations = new McpOperationService(vi.fn());
  const execute = vi.fn(async () => ({
    pagesChanged: 0,
    performed: ["source_size_measurement"],
    sourceSize: {
      sourceImageSha256: "a".repeat(64),
      expiresAt: Date.now() + 1800000,
      measuredBlocks: 1,
      items: [
        {
          blockId: "block",
          estimate: { facePx: 18, confidence: 0.8, method: "raster-core-v1" },
          excludedReason: null,
        },
      ],
      notes: [],
    },
  }));
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: createMcpOperationTools(operations, { sourceSize: execute }),
    reportError: vi.fn(),
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session,
      pairing: new McpPairingBroker(provider, secret),
    }),
  });
  const call = async (name: string, args: object, token = processor) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return response.json();
  };
  const args = {
    chapterId: "chapter",
    pageId: "page",
    revision: "page-v1:1111111111111111",
    requestId: randomUUID(),
  };
  try {
    const denied = await call("carrot_run_page_source_size", args, reader);
    expect(denied, JSON.stringify(denied)).toMatchObject({
      error: { code: -32602, message: "Unknown tool" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(
      (await call("carrot_run_page_source_size", { ...args, path: "private" }))
        .error.code,
    ).toBe(-32602);
    const started = await call("carrot_run_page_source_size", args);
    expect(started.result.isError).toBe(false);
    const jobId = started.result.structuredContent.jobId;
    let completed = started;
    for (
      let i = 0;
      i < 200 && completed.result.structuredContent.status === "running";
      i++
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      completed = await call("carrot_get_job", { jobId });
    }
    expect(completed.result.structuredContent.status).toBe("completed");
    expect(completed.result.content).toHaveLength(1);
    expect(
      completed.result.structuredContent.result.sourceSize.measuredBlocks,
    ).toBe(1);
    expect(JSON.stringify(completed)).not.toMatch(
      /resource_link|imagePath|dataUrl|"url"/,
    );
    expect(
      (await call("carrot_run_page_source_size", args)).result.structuredContent
        .jobId,
    ).toBe(jobId);
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    await server.close();
    await operations.close();
  }
});
