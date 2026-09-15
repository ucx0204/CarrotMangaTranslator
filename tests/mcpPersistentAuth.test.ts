import assert from "node:assert/strict";
import { it } from "vitest";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { McpOAuthSession } from "../src/main/mcp/mcpOAuthSession";
import { oauthDigest } from "../src/main/mcp/mcpOAuthPolicy";
import type { McpOAuthSnapshot } from "../src/main/mcp/mcpOAuthSnapshot";
const issuer = "https://carrot.tail-test.ts.net";
const password = "p".repeat(43);
const verifier = "v".repeat(43);
const callback = "https://chatgpt.com/connector/oauth/persistence-test";
function grant(provider: McpOAuthProvider) {
  const client = provider.register({
    redirect_uris: [callback],
    token_endpoint_auth_method: "none",
  });
  const pending = provider.begin({
    client_id: client.client_id,
    redirect_uri: callback,
    resource: `${issuer}/mcp`,
    response_type: "code",
    state: "test",
    scope: "carrot.read carrot.images carrot.edit offline_access",
    code_challenge: oauthDigest(verifier),
    code_challenge_method: "S256",
  });
  const redirect = provider.approve(
    {
      transaction: pending.transaction,
      decision: "approve",
      pairing_secret: password,
    },
    pending.cookie,
  );
  const tokens = provider.token({
    client_id: client.client_id,
    resource: `${issuer}/mcp`,
    grant_type: "authorization_code",
    redirect_uri: callback,
    code: new URL(redirect).searchParams.get("code"),
    code_verifier: verifier,
  });
  return { client, tokens };
}
function restart(snapshot: unknown, now = Date.now) {
  const provider = new McpOAuthProvider(issuer, password, now, {
    persistent: true,
    allowEdits: true,
    allowImages: true,
  });
  provider.restore(JSON.parse(JSON.stringify(snapshot)));
  return provider;
}
function refresh(provider: McpOAuthProvider, clientId: string, token: string) {
  return provider.token({
    client_id: clientId,
    resource: `${issuer}/mcp`,
    grant_type: "refresh_token",
    refresh_token: token,
  });
}
it("retains clients, grants and hashed tokens after restart without immortal access tokens", () => {
  let now = 1_000;
  const first = new McpOAuthProvider(issuer, password, () => now, {
    persistent: true,
    allowEdits: true,
    allowImages: true,
  });
  const { client, tokens } = grant(first);
  const saved = first.snapshot();
  assert.equal(JSON.stringify(saved).includes(tokens.access_token), false);
  assert.equal(JSON.stringify(saved).includes(tokens.refresh_token), false);
  first.close();
  now += 8 * 24 * 3600_000;
  const next = restart(saved, () => now);
  assert.equal(next.accepts(`Bearer ${tokens.access_token}`), false);
  const renewed = refresh(next, client.client_id, tokens.refresh_token);
  assert.equal(next.accepts(`Bearer ${renewed.access_token}`), true);
  assert.equal(
    next.scopeFor(`Bearer ${renewed.access_token}`),
    "carrot.read carrot.images carrot.edit offline_access",
  );
});
it("preserves shared grant identity so refresh replay revokes every token after serialization", () => {
  const first = new McpOAuthProvider(issuer, password, Date.now, {
    persistent: true,
    allowEdits: true,
    allowImages: true,
  });
  const { client, tokens } = grant(first);
  const rotated = refresh(first, client.client_id, tokens.refresh_token);
  const next = restart(first.snapshot());
  assert.throws(() => refresh(next, client.client_id, tokens.refresh_token));
  assert.equal(next.accepts(`Bearer ${rotated.access_token}`), false);
  const again = restart(next.snapshot());
  assert.equal(again.accepts(`Bearer ${rotated.access_token}`), false);
  assert.throws(() => refresh(again, client.client_id, rotated.refresh_token));
});
it("keeps explicit revocation across stop and restart", () => {
  const provider = new McpOAuthProvider(issuer, password, Date.now, {
    persistent: true,
    allowEdits: true,
    allowImages: true,
  });
  const { client, tokens } = grant(provider);
  provider.revokeConnection(provider.connections()[0].id);
  const next = restart(provider.snapshot());
  assert.equal(next.connections()[0].revoked, true);
  assert.throws(() => refresh(next, client.client_id, tokens.refresh_token));
});
it("rejects mismatched issuer, duplicate records and dangling token references before restore", () => {
  const provider = new McpOAuthProvider(issuer, password, Date.now, {
    persistent: true,
    allowEdits: true,
    allowImages: true,
  });
  grant(provider);
  const state = provider.snapshot();
  assert.throws(() =>
    restart({ ...state, issuer: "https://another.tail-test.ts.net" }),
  );
  assert.throws(() =>
    restart({ ...state, clients: [...state.clients, state.clients[0]] }),
  );
  assert.throws(() => restart({ ...state, grants: [] }));
});
it("commits a replay-triggered revocation even when the token request fails", async () => {
  const provider = new McpOAuthProvider(issuer, password, Date.now, {
    persistent: true,
    allowEdits: true,
    allowImages: true,
  });
  const { client, tokens } = grant(provider);
  const rotated = refresh(provider, client.client_id, tokens.refresh_token);
  let saved: McpOAuthSnapshot | undefined;
  const session = new McpOAuthSession(provider, {
    save: async (value) => {
      saved = value;
    },
  });
  await assert.rejects(
    session.run(() =>
      refresh(provider, client.client_id, tokens.refresh_token),
    ),
  );
  assert.equal(restart(saved).accepts(`Bearer ${rotated.access_token}`), false);
});
it("does not return success before disk commit and fails closed on persistence errors", async () => {
  const provider = new McpOAuthProvider(issuer, password, Date.now, {
    persistent: true,
    allowEdits: true,
    allowImages: true,
  });
  const { tokens } = grant(provider);
  let release!: () => void;
  const disk = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = new McpOAuthSession(provider, { save: () => disk });
  let completed = false;
  const operation = session
    .run(() => 42)
    .then((result) => {
      completed = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(completed, false);
  release();
  assert.equal(await operation, 42);
  const broken = new McpOAuthSession(provider, {
    save: async () => {
      throw new Error("disk full");
    },
  });
  await assert.rejects(
    broken.run(() => 42),
    /disk full/,
  );
  assert.equal(broken.accepts(`Bearer ${tokens.access_token}`), false);
  await assert.rejects(
    broken.run(() => 42),
    /unavailable/,
  );
});
