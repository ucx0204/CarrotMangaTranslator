import assert from "node:assert/strict";
import { it } from "vitest";
import { McpPairingService } from "../src/main/application/mcpPairingService";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { McpOAuthSession } from "../src/main/mcp/mcpOAuthSession";
import { McpOAuthHttp } from "../src/main/mcp/mcpOAuthHttp";
import { McpPairingHttp } from "../src/main/mcp/mcpPairingHttp";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { oauthDigest } from "../src/main/mcp/mcpOAuthPolicy";
const issuer = "https://carrot.tail-test.ts.net";
const password = "p".repeat(43);
function fixture(now = Date.now) {
  const provider = new McpOAuthProvider(issuer, password, now, {
    persistent: true,
  });
  const session = new McpOAuthSession(provider, {
    save: async () => undefined,
  });
  const pairing = new McpPairingService(provider, session, password, now);
  const client = provider.register({
    redirect_uris: ["https://chatgpt.com/connector/oauth/pairing-test"],
    token_endpoint_auth_method: "none",
  });
  const input = {
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    resource: `${issuer}/mcp`,
    response_type: "code",
    state: "test-state",
    code_challenge: oauthDigest("v".repeat(43)),
    code_challenge_method: "S256",
  };
  return { provider, session, pairing, input };
}
it("requires an app-opened pairing window and omits browser secrets from desktop status", () => {
  let now = 1000;
  const f = fixture(() => now);
  assert.throws(() => f.pairing.begin(f.input));
  f.pairing.open();
  const pending = f.pairing.begin(f.input);
  assert.equal(
    JSON.stringify(f.pairing.status()).includes(pending.cookie),
    false,
  );
  assert.equal(JSON.stringify(f.pairing.status()).includes(password), false);
  now += 300001;
  assert.throws(() => f.pairing.begin(f.input));
  assert.equal(f.pairing.status().pending.length, 0);
});
it("needs local approval AND the original browser cookie; restart cancels pending requests", async () => {
  const f = fixture();
  f.pairing.open();
  const pending = f.pairing.begin(f.input);
  assert.equal(
    (await f.pairing.poll(pending.id, pending.cookie)).redirect,
    undefined,
  );
  f.pairing.resolve(pending.id, true);
  await assert.rejects(f.pairing.poll(pending.id, "wrong-cookie"));
  const result = await f.pairing.poll(pending.id, pending.cookie);
  assert.ok(new URL(result.redirect!).searchParams.get("code"));
  assert.throws(() => f.pairing.resolve(pending.id, true));
  f.pairing.close();
  await assert.rejects(f.pairing.poll(pending.id, pending.cookie));
});
it("local rejection returns state and access_denied without creating a grant", async () => {
  const f = fixture();
  f.pairing.open();
  const pending = f.pairing.begin(f.input);
  f.pairing.resolve(pending.id, false);
  const result = new URL(
    (await f.pairing.poll(pending.id, pending.cookie)).redirect!,
  );
  assert.equal(result.searchParams.get("error"), "access_denied");
  assert.equal(result.searchParams.has("code"), false);
  assert.equal(result.searchParams.get("state"), "test-state");
  assert.equal(f.provider.connections().length, 0);
});
it("serves password-free HTML and disables browser password approval over real HTTP", async () => {
  const f = fixture();
  f.pairing.open();
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: issuer },
    tools: [],
    oauth: new McpOAuthHttp(
      issuer,
      password,
      f.session,
      new McpPairingHttp(f.pairing),
    ),
    reportError: (error) => {
      throw error;
    },
  });
  const base = new URL(server.url).origin;
  try {
    const response = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams(f.input)}`,
    );
    const html = await response.text();
    assert.equal(html.includes('type="password"'), false);
    assert.equal(html.includes(password), false);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const pending = f.pairing.status().pending[0];
    assert.ok(html.includes(pending.code));
    assert.equal(
      (await fetch(`${base}/oauth/approve`, { method: "POST" })).status,
      403,
    );
    f.pairing.resolve(pending.id, true);
    const completed = await fetch(`${base}/oauth/pairing?id=${pending.id}`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    assert.equal(completed.status, 303);
    assert.equal(
      new URL(completed.headers.get("location")!).origin,
      "https://chatgpt.com",
    );
  } finally {
    await server.close();
  }
});
