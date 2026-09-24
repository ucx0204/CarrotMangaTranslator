import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";
import type { createMcpLibraryOrganizationSession } from "../src/main/mcp/mcpLibraryOrganizationSession";

type Base = {
  organization: () => ReturnType<typeof createMcpLibraryOrganizationSession>;
  errors: unknown[];
  close: () => Promise<void>;
};

export async function organizationHttpFixture<T extends Base>(f: T) {
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const origin = "https://library-organization.fixture.test",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowEdits: true,
    allowProcessing: true,
  });
  const grant = createMcpTestGrant(origin, secret);
  const full = grant(provider, "carrot.read carrot.edit carrot.process");
  const read = grant(provider, "carrot.read");
  const other = grant(provider, "carrot.read carrot.edit carrot.process");
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: f.organization().tools,
    enforceScopes: true,
    reportError: (error) => f.errors.push(error),
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session: new McpOAuthSession(provider, { save: async () => {} }),
      pairing: new McpPairingBroker(provider, secret),
    }),
  });
  const http = async (name: string, args: object, token = full) =>
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
    http,
    read,
    other,
    revoke: () => {
      const id = provider.connectionIdFor(`Bearer ${full}`);
      if (!id) throw new Error("Missing authorized fixture owner");
      provider.revokeConnection(id);
    },
    close: async () => {
      await server.close();
      await f.close();
    },
  };
}
