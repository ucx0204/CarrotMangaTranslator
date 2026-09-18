import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { letteringAppFixture } from "./mcpLetteringApp.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

async function fixture() {
  const f = await letteringAppFixture();
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const origin = "https://lettering.test",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowEdits: true,
    allowProcessing: true,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const grant = createMcpTestGrant(origin, secret);
  const full = grant(provider, "carrot.read carrot.edit carrot.process"),
    read = grant(provider, "carrot.read"),
    other = grant(provider, "carrot.read carrot.edit carrot.process");
  const principal = provider.connectionIdFor(`Bearer ${full}`);
  if (!principal) throw new Error("Fixture grant missing");
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: f.tools,
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session,
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
    return { status: response.status, body: await response.json() };
  };
  const wait = async (batchId: string) => {
    await vi.waitFor(
      async () => {
        const result = await call("carrot_get_lettering_batch", { batchId });
        expect(result.body.result.isError).toBe(false);
        expect(result.body.result.structuredContent.status).not.toBe("running");
      },
      { timeout: 10000 },
    );
    return (await call("carrot_get_lettering_batch", { batchId })).body.result
      .structuredContent;
  };
  return {
    ...f,
    principal,
    provider,
    call,
    wait,
    read,
    other,
    close: async () => {
      f.session.stop();
      f.operations.stop();
      await f.operations.close();
      await server.close();
      await f.close();
    },
  };
}

it("prepares and commits independent styles with real OAuth, strict outputs and exact recovery", async () => {
  const f = await fixture();
  const before = (await f.library.openChapter("chapter")).pages.map(
    (page) => page.blocks,
  );
  try {
    const input = await f.request({
      kind: "format",
      fields: { italic: true },
      advanced: {
        textEffect: {
          enabled: true,
          color: "#123456",
          offsetXpx: 2,
          offsetYpx: 3,
          blurPx: 4,
          opacity: 0.5,
        },
      },
    });
    const accepted = (await f.call("carrot_prepare_lettering_batch", input))
      .body.result;
    expect(accepted.isError).toBe(false);
    expect(JSON.parse(accepted.content[0].text)).toEqual(
      accepted.structuredContent,
    );
    const job = await f.settleJob(
      accepted.structuredContent.jobId,
      f.principal,
    );
    expect(job.status).toBe("completed");
    const id = job.result?.letteringPlan?.batchId;
    if (!id) throw new Error(JSON.stringify(job));
    const plan = (await f.call("carrot_get_lettering_batch", { batchId: id }))
      .body.result;
    expect(plan.structuredContent.totalChanges).toBe(2);
    expect(JSON.stringify(plan)).not.toMatch(
      /imagePath|dataRoot|beforeBlock|sourceHash|sourceText/,
    );
    for (const direction of ["apply", "undo", "redo", "undo"]) {
      const receipt = await f.call(`carrot_${direction}_lettering_batch`, {
        batchId: id,
        requestId: randomUUID(),
      });
      expect(receipt.body.result.isError).toBe(false);
      expect((await f.wait(id)).status).toBe("completed");
    }
    expect(
      (await f.library.openChapter("chapter")).pages.map((page) => page.blocks),
    ).toEqual(before);
    expect(f.runPage).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rejects insufficient scopes, unknown fields, forged plans and revoked connections", async () => {
  const f = await fixture();
  const before = await readFile(f.chapterPath);
  try {
    const input = await f.request({ kind: "format", fields: { italic: true } });
    expect(
      (await f.call("carrot_prepare_lettering_batch", input, f.read)).body
        .error,
    ).toMatchObject({ code: -32602, message: "Unknown tool" });
    expect(
      (
        await f.call("carrot_prepare_lettering_batch", {
          ...input,
          path: "private",
        })
      ).body.error.code,
    ).toBe(-32602);
    const accepted = (await f.call("carrot_prepare_lettering_batch", input))
      .body.result.structuredContent;
    const job = await f.settleJob(accepted.jobId, f.principal);
    const id = job.result?.letteringPlan?.batchId;
    if (!id) throw new Error(JSON.stringify(job));
    expect(
      (await f.call("carrot_get_lettering_batch", { batchId: id }, f.other))
        .body.result.structuredContent.error,
    ).toBe("not_found");
    expect(
      (
        await f.call("carrot_apply_lettering_batch", {
          batchId: id,
          requestId: randomUUID(),
          blocks: [],
        })
      ).body.error.code,
    ).toBe(-32602);
    f.provider.revokeConnection(f.principal);
    expect(
      (
        await f.call("carrot_apply_lettering_batch", {
          batchId: id,
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(401);
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
