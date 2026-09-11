import assert from "node:assert/strict";
import { it } from "vitest";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { oauthDigest } from "../src/main/mcp/mcpOAuthPolicy";

const origin = "https://carrot.tail-test.ts.net";
const callback = "https://chatgpt.com/connector/oauth/persistent-test";
const verifier = "v".repeat(43);
function fixture() {
  const provider = new McpOAuthProvider(origin, "p".repeat(43), Date.now, {
    persistent: true,
    allowEdits: true,
  });
  const client = provider.register({
    redirect_uris: [callback],
    token_endpoint_auth_method: "client_secret_post",
  });
  const consent = provider.begin({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: callback,
    resource: `${origin}/mcp`,
    state: "test",
    scope: "carrot.read carrot.edit offline_access",
    code_challenge: oauthDigest(verifier),
    code_challenge_method: "S256",
  });
  const redirect = new URL(
    provider.approve(
      {
        transaction: consent.transaction,
        decision: "approve",
        pairing_secret: "p".repeat(43),
      },
      consent.cookie,
    ),
  );
  const tokens = provider.token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: callback,
    resource: `${origin}/mcp`,
    code: redirect.searchParams.get("code"),
    code_verifier: verifier,
  });
  return { provider, client, tokens };
}
function restart(provider: McpOAuthProvider) {
  const raw = JSON.stringify(provider.snapshot());
  provider.close();
  const restored = new McpOAuthProvider(
    origin,
    "different-secret".repeat(3),
    Date.now,
    { persistent: true, allowEdits: true },
  );
  restored.restore(JSON.parse(raw));
  return restored;
}
it("restores client authentication, access and rotating refresh grants across independent processes", () => {
  const f = fixture();
  assert.equal(f.client.client_secret_expires_at, 0);
  const snapshot = JSON.stringify(f.provider.snapshot());
  assert.equal(snapshot.includes(f.tokens.access_token), false);
  assert.equal(snapshot.includes(f.tokens.refresh_token), false);
  assert.equal(snapshot.includes(f.client.client_secret ?? "missing"), false);
  const restored = restart(f.provider);
  assert.equal(
    restored.accepts(`Bearer ${f.tokens.access_token}`, "carrot.edit"),
    true,
  );
  const next = restored.token({
    grant_type: "refresh_token",
    client_id: f.client.client_id,
    client_secret: f.client.client_secret,
    refresh_token: f.tokens.refresh_token,
    resource: `${origin}/mcp`,
  });
  assert.notEqual(next.refresh_token, f.tokens.refresh_token);
  assert.equal(restart(restored).accepts(`Bearer ${next.access_token}`), true);
});
it("keeps refresh replay tombstones and revokes every related access token after restart", () => {
  const f = fixture();
  const refresh = {
    grant_type: "refresh_token",
    client_id: f.client.client_id,
    client_secret: f.client.client_secret,
    refresh_token: f.tokens.refresh_token,
    resource: `${origin}/mcp`,
  };
  const next = f.provider.token(refresh);
  const restored = restart(f.provider);
  assert.throws(() => restored.token(refresh));
  assert.equal(restored.accepts(`Bearer ${next.access_token}`), false);
  assert.equal(
    restart(restored).accepts(`Bearer ${f.tokens.access_token}`),
    false,
  );
});
it("persists local revocation and refuses moving approvals to another resource", () => {
  const f = fixture();
  const id = f.provider.connections()[0].id;
  f.provider.revokeConnection(id);
  assert.equal(
    restart(f.provider).accepts(`Bearer ${f.tokens.access_token}`),
    false,
  );
  const other = new McpOAuthProvider(
    "https://other.tail-test.ts.net",
    "p".repeat(43),
  );
  assert.throws(
    () => other.restore(fixture().provider.snapshot()),
    /resource changed/,
  );
});
it("rejects corrupt and inconsistent persisted grants instead of restoring permissions", () => {
  const f = fixture();
  const data = JSON.parse(JSON.stringify(f.provider.snapshot()));
  data.refresh[0].value.grant.revoked = true;
  assert.throws(() => f.provider.restore(data), /Inconsistent/);
  assert.throws(() => f.provider.restore({ version: 999 }));
});
