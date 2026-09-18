import { selectionAppFixture } from "./mcpSelectionApp.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

export async function selectionHttpFixture(enableEditing = false) {
  const f = await selectionAppFixture(enableEditing);
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const origin = "https://selection.test",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowProcessing: true,
    allowEdits: enableEditing,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const grant = createMcpTestGrant(origin, secret);
  const scopes = enableEditing
    ? "carrot.read carrot.edit carrot.process"
    : "carrot.read carrot.process";
  const token = grant(provider, scopes),
    read = grant(provider, "carrot.read"),
    other = grant(provider, scopes),
    processOnly = grant(provider, "carrot.read carrot.process");
  const principal = provider.connectionIdFor(`Bearer ${token}`);
  if (!principal) throw new Error("Synthetic grant missing");
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session,
      pairing: new McpPairingBroker(provider, secret),
    }),
    tools: f.tools.map((tool) => ({
      ...tool,
      invoke: (args, context) =>
        f.withExecutionSettings(f.settings, () => tool.invoke(args, context)),
    })),
    reportError: (error) => f.errors.push(error),
  });
  const call = async (name: string, args: object, caller = token) => {
    const response = await fetch(server.url, {
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
    return { status: response.status, body: await response.json() };
  };
  return {
    ...f,
    call,
    principal,
    provider,
    read,
    other,
    processOnly,
    close: async () => {
      f.session.stop();
      f.operations.stop();
      await f.operations.close();
      await server.close();
      await f.close();
    },
  };
}
