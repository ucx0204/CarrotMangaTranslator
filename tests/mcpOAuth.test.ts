import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { it } from "vitest";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { McpOAuthState } from "../src/main/mcp/mcpOAuthState";
import { oauthDigest, readChatGptRedirect, uniqueOAuthParams } from "../src/main/mcp/mcpOAuthPolicy";
import { mcpOAuthConsentPage } from "../src/main/mcp/mcpOAuthPage";
import { readMcpConfiguration } from "../src/main/mcp/mcpConfiguration";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { createMcpToolSet } from "../src/main/mcp/mcpToolSet";

const ISSUER = "https://carrot.example";
const RESOURCE = `${ISSUER}/mcp`;
const CALLBACK = "https://chatgpt.com/connector/oauth/carrot-test";
const PASSWORD = "p".repeat(43);
const VERIFIER = "v".repeat(43);

function setup(now: () => number = Date.now) {
  const provider = new McpOAuthProvider(ISSUER, PASSWORD, now);
  const client = provider.register({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" });
  const input = {
    response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK,
    resource: RESOURCE, state: "test-state", scope: "carrot.read offline_access",
    code_challenge: oauthDigest(VERIFIER), code_challenge_method: "S256",
  };
  return { provider, client, input };
}

function authorize(fixture: ReturnType<typeof setup>) {
  const consent = fixture.provider.begin(fixture.input);
  const location = fixture.provider.approve({ transaction: consent.transaction, decision: "approve", pairing_secret: PASSWORD }, consent.cookie);
  const url = new URL(location);
  assert.equal(url.searchParams.get("state"), "test-state");
  return {
    grant_type: "authorization_code", client_id: fixture.client.client_id, resource: RESOURCE,
    redirect_uri: CALLBACK, code: url.searchParams.get("code"), code_verifier: VERIFIER,
  };
}

it("requires explicit OAuth opt-in, HTTPS and separate credentials", () => {
  const env = { CARROT_MCP_ENABLED: "1", CARROT_MCP_TOKEN: "t".repeat(43) };
  assert.equal(readMcpConfiguration(env)?.oauthPassword, undefined);
  assert.throws(() => readMcpConfiguration({ ...env, CARROT_MCP_OAUTH_ENABLED: "1" }));
  assert.throws(() => readMcpConfiguration({ ...env, CARROT_MCP_OAUTH_ENABLED: "bad" }));
  const web = { ...env, CARROT_MCP_OAUTH_ENABLED: "1", CARROT_MCP_PUBLIC_ORIGIN: ISSUER, CARROT_MCP_OAUTH_PASSWORD: PASSWORD };
  assert.equal(readMcpConfiguration(web)?.oauthPassword, PASSWORD);
  assert.throws(() => readMcpConfiguration({ ...web, CARROT_MCP_OAUTH_PASSWORD: env.CARROT_MCP_TOKEN }));
});

for (const callback of ["https://evil.example/", "https://chatgpt.com.evil.example/connector/oauth/a", "https://chatgpt.com@evil.example/connector/oauth/a", "http://chatgpt.com/connector/oauth/a", "https://chatgpt.com/connector/oauth/a?next=evil", "https://chatgpt.com/connector/oauth/a#fragment", "https://chatgpt.com/connector/oauth/../evil", "https://chatgpt.com/anything", "file:///etc/passwd"]) {
  it(`rejects untrusted callback ${callback}`, () => assert.throws(() => readChatGptRedirect(callback)));
}

it("allows current and documented legacy callbacks and rejects duplicate form fields", () => {
  assert.equal(readChatGptRedirect(CALLBACK), CALLBACK);
  assert.equal(readChatGptRedirect("https://chatgpt.com/connector_platform_oauth_redirect"), "https://chatgpt.com/connector_platform_oauth_redirect");
  assert.throws(() => uniqueOAuthParams(new URLSearchParams("resource=a&resource=b")));
});

it("bounds secret stores, expires them and clears every lease", () => {
  let now = 0;
  const store = new McpOAuthState<number>(() => now, 1);
  const token = store.issue(5, 100);
  assert.equal(store.get(token), 5);
  assert.throws(() => store.issue(6, 100));
  now = 100;
  assert.equal(store.get(token), undefined);
  const next = store.issue(6, 100);
  assert.equal(store.take(next), 6);
  assert.equal(store.take(next), undefined);
  const last = store.issue(7, 100);
  store.clear();
  assert.equal(store.get(last), undefined);
});

for (const change of [
  { resource: "https://other.example/mcp" }, { redirect_uri: "https://chatgpt.com/connector/oauth/other" },
  { code_challenge_method: "plain" }, { code_challenge: "bad" }, { scope: "carrot.write" },
  { response_type: "token" }, { state: "" }, { client_id: "unknown" },
]) {
  it(`rejects authorization mismatch ${JSON.stringify(change)}`, () => {
    const fixture = setup();
    assert.throws(() => fixture.provider.begin({ ...fixture.input, ...change }));
  });
}

it("requires a matching browser cookie and connection password; consent is single-use", () => {
  const fixture = setup();
  const consent = fixture.provider.begin(fixture.input);
  const approval = { transaction: consent.transaction, decision: "approve", pairing_secret: PASSWORD };
  assert.throws(() => fixture.provider.approve(approval, "wrong"));
  assert.throws(() => fixture.provider.approve({ ...approval, pairing_secret: "wrong" }, consent.cookie));
  assert.throws(() => fixture.provider.approve(approval, consent.cookie));
  const denied = fixture.provider.begin(fixture.input);
  const location = fixture.provider.approve({ transaction: denied.transaction, decision: "deny" }, denied.cookie);
  assert.equal(new URL(location).searchParams.get("error"), "access_denied");
  assert.equal(new URL(location).searchParams.has("code"), false);
});

it("expires pending consent and authorization codes", () => {
  let now = 1;
  const fixture = setup(() => now);
  const pending = fixture.provider.begin(fixture.input);
  now += 300_001;
  assert.throws(() => fixture.provider.approve({ transaction: pending.transaction, decision: "approve", pairing_secret: PASSWORD }, pending.cookie));
  const exchange = authorize(fixture);
  now += 60_001;
  assert.throws(() => fixture.provider.token(exchange));
});

it("binds codes to PKCE, client, redirect and audience without leaking access", () => {
  const fixture = setup();
  const exchange = authorize(fixture);
  for (const change of [{ code_verifier: "w".repeat(43) }, { resource: ISSUER }, { client_id: "unknown" }, { redirect_uri: `${CALLBACK}2` }])
    assert.throws(() => fixture.provider.token({ ...exchange, ...change }));
  const token = fixture.provider.token(exchange);
  assert.equal(fixture.provider.accepts(`Bearer ${token.access_token}`), true);
  assert.equal(fixture.provider.accepts(`Bearer ${token.refresh_token}`), false);
  assert.equal(fixture.provider.accepts(`Bearer ${PASSWORD}`), false);
  assert.throws(() => fixture.provider.token(exchange));
  assert.equal(fixture.provider.accepts(`Bearer ${token.access_token}`), false);
});

it("rotates refresh tokens and revokes their family on replay", () => {
  const fixture = setup();
  const initial = fixture.provider.token(authorize(fixture));
  const refresh = { grant_type: "refresh_token", resource: RESOURCE, client_id: fixture.client.client_id, refresh_token: initial.refresh_token };
  const next = fixture.provider.token(refresh);
  assert.notEqual(next.refresh_token, initial.refresh_token);
  assert.equal(fixture.provider.accepts(`Bearer ${next.access_token}`), true);
  assert.throws(() => fixture.provider.token(refresh));
  assert.equal(fixture.provider.accepts(`Bearer ${next.access_token}`), false);
  assert.throws(() => fixture.provider.token({ ...refresh, refresh_token: next.refresh_token }));
});

it("expires access, renews within the grant lifetime, and never extends the grant", () => {
  let now = 1;
  const fixture = setup(() => now);
  const initial = fixture.provider.token(authorize(fixture));
  now += 3_600_001;
  assert.equal(fixture.provider.accepts(`Bearer ${initial.access_token}`), false);
  const refresh = { grant_type: "refresh_token", resource: RESOURCE, client_id: fixture.client.client_id, refresh_token: initial.refresh_token };
  const next = fixture.provider.token(refresh);
  assert.equal(fixture.provider.accepts(`Bearer ${next.access_token}`), true);
  now += 24 * 3_600_000;
  assert.equal(fixture.provider.accepts(`Bearer ${next.access_token}`), false);
  assert.throws(() => fixture.provider.token({ ...refresh, refresh_token: next.refresh_token }));
});

it("supports revocation and restart invalidation", () => {
  const fixture = setup();
  const token = fixture.provider.token(authorize(fixture));
  fixture.provider.revoke({ client_id: fixture.client.client_id, token: token.refresh_token });
  assert.equal(fixture.provider.accepts(`Bearer ${token.access_token}`), false);
  const next = fixture.provider.token(authorize(fixture));
  fixture.provider.close();
  assert.equal(fixture.provider.accepts(`Bearer ${next.access_token}`), false);
  assert.throws(() => fixture.provider.begin(fixture.input));
});

for (const method of ["client_secret_post", "client_secret_basic"] as const) {
  it(`authenticates DCR confidential clients using ${method}`, () => {
    const fixture = setup();
    const client = fixture.provider.register({ redirect_uris: [CALLBACK], token_endpoint_auth_method: method });
    fixture.client = client;
    fixture.input.client_id = client.client_id;
    const exchange = authorize(fixture);
    assert.throws(() => fixture.provider.token(exchange));
    const token = method === "client_secret_post"
      ? fixture.provider.token({ ...exchange, client_secret: client.client_secret })
      : fixture.provider.token(exchange, `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`);
    assert.equal(fixture.provider.accepts(`Bearer ${token.access_token}`), true);
  });
}

it("escapes metadata in consent HTML and never embeds connection secrets", () => {
  const html = mcpOAuthConsentPage({ transaction: "tx", clientName: '<script>alert("x")</script>', scope: "carrot.read", resource: RESOURCE });
  assert.equal(html.includes("<script>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(html.includes(PASSWORD), false);
});

it("runs discovery, browser consent, tokens and MCP over actual HTTP with auth challenges", async () => {
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: ISSUER, oauthPassword: PASSWORD },
    tools: createMcpToolSet({ listLibrary: async () => ({ workOrder: [], works: [] }), openChapter: async () => { throw new Error("Not used"); } }, undefined, true),
    reportError: (error) => { throw error; },
  });
  const local = new URL(server.url).origin;
  try {
    const denied = await fetch(server.url);
    assert.equal(denied.status, 401);
    assert.ok(denied.headers.get("www-authenticate")?.includes(`${ISSUER}/.well-known/oauth-protected-resource/mcp`));
    const resource = await fetch(`${local}/.well-known/oauth-protected-resource/mcp`).then((res) => res.json());
    assert.equal(resource.resource, RESOURCE);
    const registration = await fetch(`${local}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }) });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    const auth = new URL(`${local}/oauth/authorize`);
    auth.search = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, resource: RESOURCE, state: "state", code_challenge: oauthDigest(VERIFIER), code_challenge_method: "S256" }).toString();
    const consent = await fetch(auth);
    assert.equal(consent.headers.get("referrer-policy"), "no-referrer");
    assert.ok(consent.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
    const cookie = consent.headers.get("set-cookie")?.split(";")[0] ?? "";
    const transaction = (await consent.text()).match(/name="transaction" value="([A-Za-z0-9_-]+)"/)?.[1];
    assert.ok(transaction);
    const body = new URLSearchParams({ transaction, decision: "approve", pairing_secret: PASSWORD });
    const noOrigin = await fetch(`${local}/oauth/approve`, { method: "POST", body, headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(noOrigin.status, 403);
    const approved = await fetch(`${local}/oauth/approve`, { method: "POST", body, headers: { Cookie: cookie, Origin: ISSUER }, redirect: "manual" });
    assert.equal(approved.status, 303);
    const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const tokens = await fetch(`${local}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: VERIFIER, resource: RESOURCE, redirect_uri: CALLBACK, client_id: client.client_id }) }).then((res) => res.json());
    const response = await fetch(server.url, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const listed = await response.json();
    assert.equal(listed.result.tools.length, 4);
    assert.equal(listed.result.tools[0].securitySchemes[0].type, "oauth2");
    const badHost = await readStatusWithHost(`${local}/.well-known/oauth-protected-resource`, "evil.example");
    assert.equal(badHost, 403);
    server.stopAccepting();
    assert.equal((await fetch(server.url)).status, 503);
  } finally { await server.close(); }
});

// Unlike fetch, node:http preserves the actual hostile Host header on the wire.
function readStatusWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { headers: { Host: host } }, (response) => {
      response.resume();
      response.once("error", reject);
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
  });
}
