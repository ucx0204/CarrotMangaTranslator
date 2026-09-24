import { contextMigrationAppFixture } from "./mcpContextMigrationApp.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

export async function contextHttpFixture() {
  const f = await contextMigrationAppFixture();
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const origin = "https://context-migration.test",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowEdits: true,
    allowProcessing: true,
  });
  const grant = createMcpTestGrant(origin, secret);
  const full = grant(provider, "carrot.read carrot.edit carrot.process");
  const other = grant(provider, "carrot.read carrot.edit carrot.process");
  const read = grant(provider, "carrot.read");
  const open = () =>
    startMcpHttpServer({
      config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
      tools: f.current().tools,
      enforceScopes: true,
      reportError: (error) => f.errors.push(error),
      oauthHttp: new McpOAuthHttp(origin, secret, {
        session: new McpOAuthSession(provider, { save: async () => {} }),
        pairing: new McpPairingBroker(provider, secret),
      }),
    });
  let server = await open();
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
  return {
    ...f,
    full,
    read,
    other,
    provider,
    call,
    restart: async () => {
      const saved = JSON.parse(JSON.stringify(provider.snapshot()));
      await server.close();
      provider.restore(saved);
      await f.restart();
      server = await open();
    },
    close: async () => {
      await server.close();
      await f.close();
    },
  };
}
