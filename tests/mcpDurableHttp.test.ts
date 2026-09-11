import assert from "node:assert/strict";
import { it } from "vitest";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { McpOAuthSession } from "../src/main/mcp/mcpOAuthSession";
import { McpOAuthHttp } from "../src/main/mcp/mcpOAuthHttp";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { oauthDigest } from "../src/main/mcp/mcpOAuthPolicy";
import type { McpOAuthSnapshot } from "../src/main/mcp/mcpOAuthSnapshot";

const issuer = "https://carrot.tail-test.ts.net";
const password = "p".repeat(43);
const callback = "https://chatgpt.com/connector/oauth/http-restart";
const verifier = "v".repeat(43);

it("commits HTTP token exchange and revocation and resumes after a new server instance", async () => {
  let saved: McpOAuthSnapshot | undefined;
  async function start() {
    const provider = new McpOAuthProvider(issuer, password, Date.now, {
      persistent: true,
    });
    if (saved) provider.restore(saved);
    const session = new McpOAuthSession(provider, {
      save: async (state) => {
        saved = state;
      },
    });
    const server = await startMcpHttpServer({
      config: { port: 0, token: "t".repeat(43), publicOrigin: issuer },
      oauth: new McpOAuthHttp(issuer, password, session),
      tools: [],
      reportError: (error) => {
        throw error;
      },
    });
    const base = new URL(server.url).origin;
    const post = (path: string, body: URLSearchParams) =>
      fetch(`${base}${path}`, { method: "POST", body });
    return { provider, session, server, post };
  }
  const first = await start();
  let second: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const client = await first.session.run(() =>
      first.provider.register({
        redirect_uris: [callback],
        token_endpoint_auth_method: "none",
      }),
    );
    const pending = first.provider.begin({
      client_id: client.client_id,
      redirect_uri: callback,
      resource: `${issuer}/mcp`,
      response_type: "code",
      state: "test",
      code_challenge: oauthDigest(verifier),
      code_challenge_method: "S256",
    });
    const redirect = await first.session.run(() =>
      first.provider.approve(
        {
          transaction: pending.transaction,
          decision: "approve",
          pairing_secret: password,
        },
        pending.cookie,
      ),
    );
    const response = await first.post(
      "/oauth/token",
      new URLSearchParams({
        client_id: client.client_id,
        grant_type: "authorization_code",
        resource: `${issuer}/mcp`,
        redirect_uri: callback,
        code: new URL(redirect).searchParams.get("code")!,
        code_verifier: verifier,
      }),
    );
    assert.equal(response.status, 200);
    const tokens = await response.json();
    assert.ok(saved?.refresh.length);
    await first.server.close();
    second = await start();
    assert.equal(second.session.accepts(`Bearer ${tokens.access_token}`), true);
    const refreshed = await second.post(
      "/oauth/token",
      new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        resource: `${issuer}/mcp`,
        refresh_token: tokens.refresh_token,
      }),
    );
    assert.equal(refreshed.status, 200);
    const renewed = await refreshed.json();
    const revoked = await second.post(
      "/oauth/revoke",
      new URLSearchParams({
        client_id: client.client_id,
        token: renewed.refresh_token,
      }),
    );
    assert.equal(revoked.status, 200);
    await second.server.close();
    const restored = new McpOAuthProvider(issuer, password, Date.now, {
      persistent: true,
    });
    restored.restore(saved);
    assert.equal(restored.accepts(`Bearer ${renewed.access_token}`), false);
  } finally {
    await first.server.close();
    await second?.server.close();
  }
});
