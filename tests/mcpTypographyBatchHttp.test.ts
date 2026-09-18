import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { typographyBatchAppFixture } from "./mcpTypographyBatchApp.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

async function httpFixture() {
  const f = await typographyBatchAppFixture("size");
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const origin = "https://typography-batch.test",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowEdits: true,
    allowProcessing: true,
  });
  const auth = new McpOAuthSession(provider, { save: async () => {} });
  const grant = createMcpTestGrant(origin, secret);
  const full = grant(provider, "carrot.read carrot.edit carrot.process");
  const read = grant(provider, "carrot.read");
  const other = grant(provider, "carrot.read carrot.edit carrot.process");
  const principal = provider.connectionIdFor(`Bearer ${full}`);
  if (!principal) throw new Error("OAuth fixture grant is missing");
  const request = await f.analyze(principal);
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: f.session.tools,
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session: auth,
      pairing: new McpPairingBroker(provider, secret),
    }),
    reportError: (error) => f.errors.push(error),
  });
  const call = async (name: string, args: object, token = full) => {
    const response = await fetch(server.url, {
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
  const done = async (batchId: string) => {
    await vi.waitFor(
      async () => {
        const response = await call("carrot_get_typography_batch", { batchId });
        expect(response.result.isError).toBe(false);
        expect(response.result.structuredContent.status).not.toBe("running");
      },
      { timeout: 5000 },
    );
    return (await call("carrot_get_typography_batch", { batchId })).result
      .structuredContent;
  };
  return {
    ...f,
    request,
    provider,
    principal,
    call,
    done,
    read,
    other,
    close: async () => {
      await f.session.close();
      await server.close();
      await f.close();
    },
  };
}

it("returns structured typography plans and completes exact apply/undo/redo through real HTTP", async () => {
  const f = await httpFixture();
  try {
    const original = await f.library.openChapter("chapter");
    const response = await f.call("carrot_preview_typography_batch", f.request);
    expect(response.result.isError).toBe(false);
    expect(response.result.content).toHaveLength(1);
    expect(JSON.parse(response.result.content[0].text)).toEqual(
      response.result.structuredContent,
    );
    const batchId = response.result.structuredContent.batchId;
    for (const direction of ["apply", "undo", "redo", "undo"]) {
      const receipt = await f.call(`carrot_${direction}_typography_batch`, {
        batchId,
        requestId: randomUUID(),
      });
      expect(receipt.result.isError).toBe(false);
      expect(receipt.result.structuredContent.status).toBe("accepted");
      expect((await f.done(batchId)).status).toBe("completed");
    }
    expect(
      (await f.library.openChapter("chapter")).pages.map((page) => page.blocks),
    ).toEqual(original.pages.map((page) => page.blocks));
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.app.jobs.all).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("denies read-only edits, cross-owner observations and invalid payloads without saving", async () => {
  const f = await httpFixture();
  try {
    const before = await readFile(f.chapterPath);
    const denied = await f.call(
      "carrot_preview_typography_batch",
      f.request,
      f.read,
    );
    expect(denied.error).toMatchObject({
      code: -32602,
      message: "Unknown tool",
    });
    const wrongOwner = await f.call(
      "carrot_preview_typography_batch",
      f.request,
      f.other,
    );
    expect(wrongOwner.result.isError).toBe(true);
    expect(wrongOwner.result.structuredContent.error).toBe("not_found");
    const invalid = await f.call("carrot_preview_typography_batch", {
      ...f.request,
      blocks: [],
    });
    expect(invalid.error.code).toBe(-32602);
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.editing.notifySaved).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
