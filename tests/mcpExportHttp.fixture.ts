import { expect, vi } from "vitest";
import { exportFixture } from "./mcpExportBatch.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { createMcpExportBatchTools } from "../src/main/mcp/mcpExportBatchTools";
import { createMcpOperationTools } from "../src/main/mcp/mcpOperationTools";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { McpOAuthHttp } from "../src/main/mcp/mcpOAuthHttp";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { McpOAuthSession } from "../src/main/mcp/mcpOAuthSession";
import { McpPairingBroker } from "../src/main/mcp/mcpPairingBroker";

export async function exportHttpFixture() {
  const f = exportFixture();
  const origin = "https://export.test";
  const secret = "test-only-secret-".repeat(3);
  const operations = new McpOperationService(f.reportError);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    persistent: true,
    allowImages: true,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const pairing = new McpPairingBroker(provider, secret);
  const tools = [
    ...createMcpExportBatchTools(f.service, operations, true),
    ...createMcpOperationTools(
      operations,
      {
        exportPng: async () => {
          throw new Error("Unexpected single export");
        },
      },
      f.store.assertAvailable.bind(f.store),
    ),
  ];
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    enforceScopes: true,
    reportError: f.reportError,
    artifacts: f.store,
    oauthHttp: new McpOAuthHttp(origin, secret, { session, pairing }),
    tools,
  });
  const grant = createMcpTestGrant(origin, secret);
  const token = grant(provider, "carrot.read carrot.images");
  const send = (path: string, init: RequestInit = {}) =>
    fetch(`${new URL(server.url).origin}${path}`, {
      ...init,
      redirect: "manual",
    });
  const call = async (name: string, args: object, caller = token) => {
    const response = await send("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${caller}`,
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
  const finish = async (jobId: string) => {
    await vi.waitFor(async () => {
      const response = await call("carrot_get_job", { jobId });
      expect(response.result.isError).toBe(false);
      expect(response.result.structuredContent.status).not.toBe("running");
    });
    return (await call("carrot_get_job", { jobId })).result.structuredContent;
  };
  return {
    ...f,
    operations,
    provider,
    session,
    server,
    tools,
    token,
    send,
    call,
    finish,
    grant: (scope: string) => grant(provider, scope),
    close: async () => {
      operations.stop();
      f.store.stop();
      await operations.close();
      await server.close();
      await f.close();
    },
  };
}
