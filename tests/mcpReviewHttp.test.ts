import { expect, it, vi } from "vitest";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { McpOAuthHttp } from "../src/main/mcp/mcpOAuthHttp";
import { McpOAuthSession } from "../src/main/mcp/mcpOAuthSession";
import { McpPairingBroker } from "../src/main/mcp/mcpPairingBroker";
import { oauthDigest } from "../src/main/mcp/mcpOAuthPolicy";
import { reviewToolsFixture } from "./mcpReviewTools.fixture";

async function fixture() {
  const f = reviewToolsFixture();
  const origin = "https://review.tail-test.ts.net",
    secret = "p".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    persistent: true,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const pairing = new McpPairingBroker(provider, secret);
  const reportError = vi.fn();
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: f.tools,
    reportError,
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, { session, pairing }),
  });
  const callback = "https://chatgpt.com/connector/oauth/review-test";
  const client = provider.register({
    redirect_uris: [callback],
    token_endpoint_auth_method: "none",
  });
  const pending = provider.begin({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: callback,
    resource: `${origin}/mcp`,
    scope: "carrot.read",
    state: "test",
    code_challenge: oauthDigest(secret),
    code_challenge_method: "S256",
  });
  const redirect = new URL(
    provider.approve(
      {
        transaction: pending.transaction,
        decision: "approve",
        pairing_secret: secret,
      },
      pending.cookie,
    ),
  );
  const token = provider.token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: callback,
    resource: `${origin}/mcp`,
    code: redirect.searchParams.get("code"),
    code_verifier: secret,
  }).access_token;
  const rpc = (method: string, params = {}, bearer = token) =>
    fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  return { ...f, provider, session, server, rpc, reportError };
}
it("permits both real preflight and review with only read scope and validates structured responses", async () => {
  const f = await fixture();
  try {
    const listed = await (await f.rpc("tools/list")).json();
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "carrot_get_chapter_review",
      "carrot_preflight_page_export",
    ]);
    expect(
      listed.result.tools.every(
        (t: { outputSchema?: unknown }) => !!t.outputSchema,
      ),
    ).toBe(true);
    for (const name of [
      "carrot_get_chapter_review",
      "carrot_preflight_page_export",
    ]) {
      const args =
        name === "carrot_get_chapter_review"
          ? { chapterId: "chapter" }
          : { chapterId: "chapter", pageId: "page" };
      const response = await f.rpc("tools/call", { name, arguments: args });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.result.isError).toBe(false);
      expect(body.result.structuredContent).toMatchObject({
        chapterId: "chapter",
      });
      expect(JSON.parse(body.result.content[0].text)).toEqual(
        body.result.structuredContent,
      );
      expect(JSON.stringify(body)).not.toMatch(
        /PRIVATE|private|sourceText|sampleRelativePath/,
      );
    }
    expect((await f.rpc("tools/list", {}, "wrong")).status).toBe(401);
    expect(f.reportError).not.toHaveBeenCalled();
  } finally {
    await f.server.close();
  }
});
it("rejects injected paths and returns typed missing-page failures without starting any operation", async () => {
  const f = await fixture();
  try {
    const name = "carrot_preflight_page_export";
    const invalid = await (
      await f.rpc("tools/call", {
        name,
        arguments: { chapterId: "chapter", pageId: "page", path: "private" },
      })
    ).json();
    expect(invalid.error.code).toBe(-32602);
    expect(f.repository.openChapter).not.toHaveBeenCalled();
    const missing = await (
      await f.rpc("tools/call", {
        name,
        arguments: { chapterId: "chapter", pageId: "absent" },
      })
    ).json();
    expect(missing.result.isError).toBe(true);
    expect(missing.result.structuredContent.error).toBe("not_found");
    f.repository.openChapter.mockRejectedValueOnce(
      new Error("C:/private/credentials"),
    );
    const failed = await (
      await f.rpc("tools/call", {
        name,
        arguments: { chapterId: "chapter", pageId: "page" },
      })
    ).json();
    expect(failed.result.structuredContent.error).toBe("operation_failed");
    expect(JSON.stringify(failed)).not.toMatch(/private|credentials/);
  } finally {
    await f.server.close();
  }
});
it("withholds pending review data when its grant is revoked before returning", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.repository.openChapter.mockImplementationOnce(async () => {
    entered();
    await pending;
    return structuredClone(f.chapter);
  });
  try {
    const request = f.rpc("tools/call", {
      name: "carrot_get_chapter_review",
      arguments: { chapterId: "chapter" },
    });
    await started;
    await f.session.run(() =>
      f.provider.revokeConnection(f.provider.connections()[0].id),
    );
    release();
    const body = await (await request).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error).toBe("access_denied");
    expect(body.result.structuredContent.summary).toBeUndefined();
    expect((await f.rpc("tools/list")).status).toBe(401);
  } finally {
    release();
    await f.server.close();
  }
});
