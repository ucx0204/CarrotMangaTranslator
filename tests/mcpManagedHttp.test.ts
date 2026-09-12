import assert from "node:assert/strict";
import { it } from "vitest";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { McpOAuthSession } from "../src/main/mcp/mcpOAuthSession";
import { McpOAuthHttp } from "../src/main/mcp/mcpOAuthHttp";
import { McpPairingBroker } from "../src/main/mcp/mcpPairingBroker";
import type { McpOAuthSnapshot } from "../src/main/mcp/mcpOAuthSnapshot";
import { oauthDigest } from "../src/main/mcp/mcpOAuthPolicy";

const issuer = "https://carrot.tail-test.ts.net";
const callback = "https://chatgpt.com/connector/oauth/managed-test";
const secret = "p".repeat(43);
const verifier = "v".repeat(43);
async function fixture(
  snapshot?: McpOAuthSnapshot,
  editAction?: (context?: { assertAuthorized: () => void }) => Promise<void>,
) {
  const provider = new McpOAuthProvider(issuer, secret, Date.now, {
    persistent: true,
    allowEdits: true,
    allowImages: true,
  });
  if (snapshot) provider.restore(snapshot);
  let saved = snapshot;
  let failSaving = false;
  let edits = 0;
  const session = new McpOAuthSession(provider, {
    save: async (state) => {
      if (failSaving) throw new Error("disk unavailable");
      saved = structuredClone(state);
    },
  });
  const pairing = new McpPairingBroker(provider, secret);
  const oauthHttp = new McpOAuthHttp(issuer, secret, { session, pairing });
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: issuer },
    oauthHttp,
    enforceScopes: true,
    reportError: () => {},
    tools: [
      {
        name: "read",
        description: "read fixture",
        inputSchema: {},
        invoke: async () => [{ type: "text", text: "read" }],
      },
      {
        name: "edit",
        description: "edit fixture",
        inputSchema: {},
        requiredScopes: ["carrot.read", "carrot.edit"],
        readOnly: false,
        invoke: async (_args, context) => {
          if (editAction) await editAction(context);
          context?.assertAuthorized();
          edits++;
          return [{ type: "text", text: "edited" }];
        },
      },
    ],
  });
  const send = (path: string, init: RequestInit = {}) =>
    fetch(`${new URL(server.url).origin}${path}`, {
      ...init,
      redirect: "manual",
    });
  return {
    server,
    session,
    provider,
    pairing,
    send,
    saved: () => saved,
    edits: () => edits,
    fail: () => {
      failSaving = true;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function register(f: Fixture) {
  return f.send("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "<script>fake</script>",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
    }),
  });
}
async function begin(f: Fixture, scope = "carrot.read offline_access") {
  f.pairing.open();
  const registered = await register(f);
  assert.equal(registered.status, 201);
  const client = await registered.json();
  const response = await f.send(
    `/oauth/authorize?${new URLSearchParams({
      client_id: client.client_id,
      response_type: "code",
      redirect_uri: callback,
      resource: `${issuer}/mcp`,
      scope,
      state: "browser-state",
      code_challenge: oauthDigest(verifier),
      code_challenge_method: "S256",
    })}`,
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes("&lt;script&gt;fake&lt;/script&gt;"));
  assert.equal(html.includes(secret), false);
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const pending = f.pairing.status().pending[0];
  assert.ok(pending);
  const headers = { Origin: issuer, Cookie: cookie };
  const body = new URLSearchParams({ transaction: pending.id });
  return { client, pending, headers, body };
}
async function link(f: Fixture, scope?: string) {
  const browser = await begin(f, scope);
  f.pairing.resolve(browser.pending.id, true);
  const done = await f.send("/oauth/complete", { method: "POST", ...browser });
  assert.equal(done.status, 303);
  const redirect = new URL(done.headers.get("location") ?? "");
  assert.equal(redirect.searchParams.get("state"), "browser-state");
  const response = await f.send("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: browser.client.client_id,
      grant_type: "authorization_code",
      redirect_uri: callback,
      code_verifier: verifier,
      code: redirect.searchParams.get("code") ?? "",
      resource: `${issuer}/mcp`,
    }),
  });
  assert.equal(response.status, 200);
  return { clientId: browser.client.client_id, tokens: await response.json() };
}
function rpc(f: Fixture, token: string, method = "tools/list", params = {}) {
  return f.send("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
it("requires a locally opened window, browser cookie and app approval, never a remote password", async () => {
  const f = await fixture();
  try {
    assert.equal((await register(f)).status, 403);
    const b = await begin(f);
    for (const headers of [
      { Cookie: b.headers.Cookie },
      { ...b.headers, Origin: "null" },
      { ...b.headers, Cookie: "wrong" },
    ]) {
      assert.equal(
        (await f.send("/oauth/poll", { method: "POST", body: b.body, headers }))
          .status,
        403,
      );
    }
    assert.equal(
      (await f.send("/oauth/complete", { method: "POST", ...b })).status,
      403,
    );
    assert.equal(
      (await f.send("/oauth/approve", { method: "POST", ...b })).status,
      403,
    );
    f.pairing.resolve(b.pending.id, false);
    const done = await f.send("/oauth/complete", { method: "POST", ...b });
    assert.equal(done.status, 303);
    const result = new URL(done.headers.get("location") ?? "");
    assert.equal(result.searchParams.get("error"), "access_denied");
    assert.equal(result.searchParams.has("code"), false);
    assert.equal(
      (await f.send("/oauth/complete", { method: "POST", ...b })).status,
      403,
    );
  } finally {
    await f.server.close();
  }
});
it("commits HTTP OAuth grants before response, survives restart and keeps revocation", async () => {
  const f = await fixture();
  const linked = await link(f, "carrot.read carrot.edit offline_access");
  const saved = f.saved();
  assert.ok(saved);
  await f.server.close();
  const restarted = await fixture(saved);
  try {
    const response = await rpc(
      restarted,
      linked.tokens.access_token,
      "tools/call",
      { name: "edit", arguments: {} },
    );
    assert.equal(response.status, 200);
    assert.equal(restarted.edits(), 1);
    const renew = await restarted.send("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: linked.clientId,
        refresh_token: linked.tokens.refresh_token,
        resource: `${issuer}/mcp`,
      }),
    });
    assert.equal(renew.status, 200);
    const next = await renew.json();
    await restarted.session.run(() =>
      restarted.provider.revokeConnection(
        restarted.provider.connections()[0].id,
      ),
    );
    const denied = await rpc(restarted, next.access_token);
    assert.equal(denied.status, 401);
    const afterRevoke = await fixture(restarted.saved());
    try {
      assert.equal((await rpc(afterRevoke, next.access_token)).status, 401);
    } finally {
      await afterRevoke.server.close();
    }
  } finally {
    await restarted.server.close();
  }
});
it("rejects direct write calls with read-only grants and stops without deleting saved approvals", async () => {
  const f = await fixture();
  try {
    const linked = await link(f);
    const listed = await rpc(f, linked.tokens.access_token).then((r) =>
      r.json(),
    );
    assert.deepEqual(
      listed.result.tools.map((t: { name: string }) => t.name),
      ["read"],
    );
    const call = await rpc(f, linked.tokens.access_token, "tools/call", {
      name: "edit",
      arguments: {},
    }).then((r) => r.json());
    assert.ok(call.error || call.result?.isError);
    assert.equal(f.edits(), 0);
    f.server.stopAccepting();
    assert.equal((await rpc(f, linked.tokens.access_token)).status, 503);
    assert.equal(f.saved()?.grants[0].revoked, false);
  } finally {
    await f.server.close();
  }
});
it("does not issue successful registration when durable persistence fails", async () => {
  const f = await fixture();
  try {
    f.pairing.open();
    f.fail();
    assert.equal((await register(f)).status, 500);
    assert.equal(f.session.accepts(`Bearer ${"t".repeat(43)}`), false);
    assert.equal(f.saved(), undefined);
  } finally {
    await f.server.close();
  }
});

it("rechecks an accepted tool after an awaited local editor check when its grant was revoked", async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const f = await fixture(undefined, async () => {
    entered();
    await blocked;
  });
  try {
    const linked = await link(f, "carrot.read carrot.edit offline_access");
    const response = rpc(f, linked.tokens.access_token, "tools/call", {
      name: "edit",
      arguments: {},
    });
    await started;
    await f.session.run(() =>
      f.provider.revokeConnection(f.provider.connections()[0].id),
    );
    release();
    const result = await (await response).json();
    assert.equal(result.result.isError, true);
    assert.ok(JSON.stringify(result).includes("access_denied"));
    assert.equal(f.edits(), 0);
  } finally {
    release();
    await f.server.close();
  }
});
it("drains already running tool work on close and blocks a late side effect", async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const f = await fixture(undefined, async () => {
    entered();
    await blocked;
  });
  const linked = await link(f, "carrot.read carrot.edit offline_access");
  // Consume the expected socket closure without masking the server close assertions.
  const response = rpc(f, linked.tokens.access_token, "tools/call", {
    name: "edit",
    arguments: {},
  }).then(
    (res) => ({ status: res.status }),
    (error) => ({ error }),
  );
  await started;
  let closed = false;
  const closing = f.server.close().then(() => {
    closed = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closed, false);
    release();
    await closing;
    await response;
    assert.equal(f.edits(), 0);
    assert.equal(f.saved()?.grants[0].revoked, false);
  } finally {
    release();
    await closing;
    await response;
  }
});
