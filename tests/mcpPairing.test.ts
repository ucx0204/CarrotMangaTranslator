import assert from "node:assert/strict";
import { it } from "vitest";
import { McpPairingBroker } from "../src/main/mcp/mcpPairingBroker";
import { mcpPairingPage } from "../src/main/mcp/mcpPairingPage";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { McpOAuthSession } from "../src/main/mcp/mcpOAuthSession";
import { McpOAuthHttp } from "../src/main/mcp/mcpOAuthHttp";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { oauthDigest } from "../src/main/mcp/mcpOAuthPolicy";
const issuer = "https://carrot.tail-test.ts.net";
const password = "p".repeat(43);

it("describes current file, editing and model permissions while escaping untrusted client and scope labels", () => {
  const { html } = mcpPairingPage({
    transaction: "transaction",
    clientName: '<img src=x onerror="alert(1)">',
    resource: `${issuer}/mcp`,
    scope:
      " carrot.read   carrot.images carrot.edit carrot.process offline_access <img> constructor __proto__ toString ",
    code: "739412",
  });
  assert.ok(
    html.includes(
      "보관함·텍스트·문맥 조회 · 이미지 및 이미지 포함 파일 전송 · 텍스트·서식·문맥 편집 · 블록·보관함 관리와 앱 모델 처리 · 다음 실행에도 승인 유지 · &lt;img&gt; · constructor · __proto__ · toString",
    ),
  );
  assert.ok(
    html.includes(
      "외부 제공자를 사용하는 작업은 필요한 텍스트나 이미지를 전송하며 요금이 발생할 수 있습니다.",
    ),
  );
  assert.ok(html.includes("연결 승인만으로 작업을 시작하지는 않습니다."));
  assert.ok(html.includes("739412"));
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes('type="password"'), false);
});
function fixture(now = Date.now) {
  const provider = new McpOAuthProvider(issuer, password, now, {
    persistent: true,
  });
  const session = new McpOAuthSession(provider, {
    save: async () => undefined,
  });
  const pairing = new McpPairingBroker(provider, password, now);
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
it("accepts new connections at startup and after long idle without a timed enrollment window", () => {
  let now = 1000;
  const f = fixture(() => now);
  const pending = f.pairing.begin(f.input);
  assert.match(pending.code, /^\d{6}$/);
  assert.equal(
    JSON.stringify(f.pairing.status()).includes(pending.cookie),
    false,
  );
  assert.equal(JSON.stringify(f.pairing.status()).includes(password), false);
  assert.equal(f.provider.connections().length, 0);
  now += 24 * 60 * 60_000;
  assert.equal(f.pairing.status().pending.length, 0);
  assert.throws(() => f.pairing.resolve(pending.transaction, true));
  assert.throws(() => f.pairing.complete(pending.transaction, pending.cookie));
  const next = f.pairing.begin(f.input);
  assert.equal(f.pairing.poll(next.transaction, next.cookie), "pending");
  assert.equal(f.provider.connections().length, 0);
});
it("bounds pending requests and frees expired slots without disabling new enrollment", () => {
  let now = 1000;
  const f = fixture(() => now);
  for (let index = 0; index < 8; index++) f.pairing.begin(f.input);
  assert.equal(f.pairing.status().pending.length, 8);
  assert.throws(() => f.pairing.begin(f.input), { status: 429 });
  now += 300001;
  assert.equal(f.pairing.status().pending.length, 0);
  const pending = f.pairing.begin(f.input);
  assert.equal(f.pairing.poll(pending.transaction, pending.cookie), "pending");
});
it("closes enrollment and discards pending approvals when MCP stops", () => {
  const f = fixture();
  const pending = f.pairing.begin(f.input);
  f.pairing.close();
  assert.equal(f.pairing.status().pending.length, 0);
  assert.throws(() => f.pairing.begin(f.input), { status: 403 });
  assert.throws(() => f.pairing.assertAccepting(), { status: 403 });
  assert.throws(() => f.pairing.resolve(pending.transaction, true));
  assert.throws(() => f.pairing.complete(pending.transaction, pending.cookie));
  assert.equal(f.provider.connections().length, 0);
});
it("needs local approval AND the original browser cookie; restart cancels pending requests", async () => {
  const f = fixture();
  const pending = f.pairing.begin(f.input);
  assert.equal(f.pairing.poll(pending.transaction, pending.cookie), "pending");
  assert.throws(() => f.pairing.complete(pending.transaction, pending.cookie), {
    status: 403,
  });
  assert.throws(() => f.pairing.resolve(pending.code, true));
  assert.equal(f.provider.connections().length, 0);
  f.pairing.resolve(pending.transaction, true);
  assert.throws(() => f.pairing.poll(pending.transaction, "wrong-cookie"));
  const result = await f.session.run(() =>
    f.pairing.complete(pending.transaction, pending.cookie),
  );
  assert.ok(new URL(result).searchParams.get("code"));
  assert.throws(() => f.pairing.resolve(pending.transaction, true));
  f.pairing.close();
  assert.throws(() => f.pairing.poll(pending.transaction, pending.cookie));
});
it("local rejection returns state and access_denied without creating a grant", async () => {
  const f = fixture();
  const pending = f.pairing.begin(f.input);
  f.pairing.resolve(pending.transaction, false);
  const result = new URL(
    await f.session.run(() =>
      f.pairing.complete(pending.transaction, pending.cookie),
    ),
  );
  assert.equal(result.searchParams.get("error"), "access_denied");
  assert.equal(result.searchParams.has("code"), false);
  assert.equal(result.searchParams.get("state"), "test-state");
  assert.equal(f.provider.connections().length, 0);
});
it("serves password-free HTML and disables browser password approval over real HTTP", async () => {
  const f = fixture();
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: issuer },
    tools: [],
    oauthHttp: new McpOAuthHttp(issuer, password, {
      session: f.session,
      pairing: f.pairing,
    }),
    reportError: (error) => {
      throw error;
    },
  });
  const base = new URL(server.url).origin;
  try {
    assert.deepEqual(await (await fetch(`${base}/`)).json(), {
      service: "Carrot MCP",
      mode: "permission-scoped",
      authentication: "OAuth",
      endpoint: `${issuer}/mcp`,
    });
    const response = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams(f.input)}`,
    );
    const html = await response.text();
    assert.equal(html.includes('type="password"'), false);
    assert.equal(html.includes(password), false);
    const setCookie = response.headers.get("set-cookie");
    assert.ok(setCookie);
    const cookie = setCookie.split(";")[0];
    const pending = f.pairing.status().pending[0];
    assert.ok(html.includes(pending.code));
    assert.equal(
      (
        await fetch(`${base}/oauth/approve`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: issuer },
          body: new URLSearchParams({
            transaction: pending.id,
            decision: "approve",
            pairing_secret: password,
          }),
        })
      ).status,
      403,
    );
    f.pairing.resolve(pending.id, true);
    const completed = await fetch(`${base}/oauth/complete`, {
      method: "POST",
      body: new URLSearchParams({ transaction: pending.id }),
      headers: { Cookie: cookie, Origin: issuer },
      redirect: "manual",
    });
    assert.equal(completed.status, 303);
    const location = completed.headers.get("location");
    assert.ok(location);
    assert.equal(new URL(location).origin, "https://chatgpt.com");
  } finally {
    await server.close();
  }
});
