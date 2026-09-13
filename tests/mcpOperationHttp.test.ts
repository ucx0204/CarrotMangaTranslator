import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { createMcpOperationTools } from "../src/main/mcp/mcpOperationTools";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { McpOAuthHttp } from "../src/main/mcp/mcpOAuthHttp";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { McpOAuthSession } from "../src/main/mcp/mcpOAuthSession";
import { McpPairingBroker } from "../src/main/mcp/mcpPairingBroker";
import { oauthDigest } from "../src/main/mcp/mcpOAuthPolicy";

const origin = "https://carrot.test.ts.net";
const secret = "p".repeat(43);
function mint(provider: McpOAuthProvider, scope: string) {
  const callback = "https://chatgpt.com/connector/oauth/outputs-test";
  const client = provider.register({
    redirect_uris: [callback],
    token_endpoint_auth_method: "none",
  });
  const pending = provider.begin({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: callback,
    resource: `${origin}/mcp`,
    scope,
    state: "test",
    code_challenge: oauthDigest(secret),
    code_challenge_method: "S256",
  });
  const url = new URL(
    provider.approve(
      {
        transaction: pending.transaction,
        decision: "approve",
        pairing_secret: secret,
      },
      pending.cookie,
    ),
  );
  const tokens = provider.token({
    client_id: client.client_id,
    grant_type: "authorization_code",
    redirect_uri: callback,
    resource: `${origin}/mcp`,
    code: url.searchParams.get("code"),
    code_verifier: secret,
  });
  return { client, tokens };
}
async function fixture() {
  const artifacts = new McpArtifactStore(origin);
  const operations = new McpOperationService(() => {});
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    persistent: true,
    allowImages: true,
    allowProcessing: true,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const pairing = new McpPairingBroker(provider, secret);
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    enforceScopes: true,
    reportError: () => {},
    artifacts,
    oauthHttp: new McpOAuthHttp(origin, secret, { session, pairing }),
    tools: createMcpOperationTools(operations, {
      exportPng: async (_target, context) => ({
        kind: "rendered-page-png",
        ...(await artifacts.put(Buffer.from("test-png"), async () =>
          context.assertAuthorized(),
        )),
      }),
    }),
  });
  const send = (path: string, init: RequestInit = {}) =>
    fetch(`${new URL(server.url).origin}${path}`, {
      ...init,
      redirect: "manual",
    });
  const call = async (token: string, name: string, args: unknown) => {
    const response = await send("/mcp", {
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
    });
    return response.json();
  };
  return {
    server,
    operations,
    provider,
    session,
    artifacts,
    send,
    call,
    close: async () => {
      operations.stop();
      artifacts.stop();
      await operations.close();
      await server.close();
      await artifacts.close();
    },
  };
}
async function awaitJob(
  call: Awaited<ReturnType<typeof fixture>>["call"],
  token: string,
  jobId: string,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await call(token, "carrot_get_job", { jobId });
    if (
      response.result?.isError ||
      JSON.parse(response.result.content[0].text).status !== "running"
    )
      return response;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "The output operation did not finish within the test deadline.",
  );
}
it("binds receipts to the OAuth grant across refresh, isolates clients and protects PNG downloads", async () => {
  const f = await fixture();
  try {
    const a = mint(f.provider, "carrot.read carrot.images offline_access");
    const b = mint(f.provider, "carrot.read carrot.images");
    const target = {
      chapterId: "chapter",
      pageId: "page",
      revision: "page-v1:0000000000000000",
      requestId: randomUUID(),
    };
    const started = await f.call(
      a.tokens.access_token,
      "carrot_export_page_png",
      target,
    );
    expect(started.result.isError).toBe(false);
    const { jobId } = JSON.parse(started.result.content[0].text);
    const refreshed = await f.session.run(() =>
      f.provider.token({
        client_id: a.client.client_id,
        grant_type: "refresh_token",
        refresh_token: a.tokens.refresh_token,
        resource: `${origin}/mcp`,
      }),
    );
    const finished = await awaitJob(f.call, refreshed.access_token, jobId);
    expect(finished.result.isError).toBe(false);
    const result = JSON.parse(finished.result.content[0].text);
    expect(result.status).toBe("completed");
    expect(finished.result.content[1]).toMatchObject({
      type: "resource_link",
      mimeType: "image/png",
    });
    const denied = await f.call(b.tokens.access_token, "carrot_get_job", {
      jobId,
    });
    expect(denied.result.isError).toBe(true);
    const path = new URL(result.result.url).pathname;
    const png = await f.send(path);
    expect(png.status).toBe(200);
    expect(await png.text()).toBe("test-png");
    expect(png.headers.get("cache-control")).toBe("no-store");
    expect((await f.send(path, { method: "HEAD" })).status).toBe(200);
    expect((await f.send(path, { method: "POST" })).status).toBe(405);
    expect(
      (await f.send(path, { headers: { Origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
    expect((await f.send("/mcp-artifacts/not-a-token/page.png")).status).toBe(
      404,
    );
    await f.session.run(() =>
      f.provider.revokeConnection(
        f.provider.connectionIdFor(`Bearer ${a.tokens.access_token}`) ??
          "missing",
      ),
    );
    expect((await f.send(path)).status).toBe(404);
    f.server.stopAccepting();
    expect((await f.send(path)).status).toBe(503);
  } finally {
    await f.close();
  }
});
it("does not expose export to a read-only grant or accept injected paths", async () => {
  const f = await fixture();
  try {
    const a = mint(f.provider, "carrot.read");
    const denied = await f.call(
      a.tokens.access_token,
      "carrot_export_page_png",
      {},
    );
    expect(denied.error.code).toBe(-32602);
    const b = mint(f.provider, "carrot.read carrot.images");
    const bad = await f.call(b.tokens.access_token, "carrot_export_page_png", {
      chapterId: "chapter",
      pageId: "page",
      revision: "page-v1:0000000000000000",
      requestId: randomUUID(),
      path: "C:/private",
    });
    expect(bad.error.code).toBe(-32602);
  } finally {
    await f.close();
  }
});
