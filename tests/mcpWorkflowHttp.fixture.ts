import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";
import { createPageRevision } from "../src/shared/pageRevision";

export async function workflowHttp() {
  const f = await workflowFixture();
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const origin = "https://workflow.test",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowEdits: true,
    allowProcessing: true,
    allowImages: true,
  });
  const auth = new McpOAuthSession(provider, { save: async () => {} });
  const grant = createMcpTestGrant(origin, secret);
  const full = grant(
    provider,
    "carrot.read carrot.edit carrot.process carrot.images",
  );
  const limited = grant(provider, "carrot.read carrot.edit carrot.process");
  const read = grant(provider, "carrot.read");
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: f.current().tools,
    artifacts: f.current().artifacts,
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session: auth,
      pairing: new McpPairingBroker(provider, secret),
    }),
    reportError: (error) => f.errors.push(error),
  });
  const call = async (name: string, args: object, token = full) =>
    (
      await fetch(server.url, {
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
      })
    ).json();
  const prepare = async (token = full) => {
    const chapter = await f.library.openChapter("chapter");
    const result = await call(
      "carrot_prepare_workflow",
      {
        requestId: randomUUID(),
        reason: "HTTP workflow",
        stages: [{ kind: "export-png" }],
        chapters: [
          {
            chapterId: "chapter",
            pages: chapter.pages.map((page) => ({
              pageId: page.id,
              revision: createPageRevision(page),
            })),
          },
        ],
      },
      token,
    );
    expect(result.result.isError).toBe(false);
    return result.result.structuredContent;
  };
  return {
    ...f,
    call,
    prepareHttp: prepare,
    full,
    limited,
    read,
    provider,
    close: async () => {
      await server.close();
      await f.close();
    },
  };
}
