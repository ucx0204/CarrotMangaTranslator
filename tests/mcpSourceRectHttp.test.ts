import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { oauthDigest } from "../src/main/mcp/mcpOAuthPolicy";
import { createPageRevision } from "../src/shared/pageRevision";
import { recoveryLibrary } from "./mcpErasureRecovery.fixture";

const origin = "https://source-rect.test.ts.net";
const secret = "s".repeat(43);
const name = "carrot_update_block_source_rect";
function grant(provider: McpOAuthProvider, scope: string) {
  const redirect_uri = "https://chatgpt.com/connector/oauth/source-rect-test";
  const client = provider.register({
    redirect_uris: [redirect_uri],
    token_endpoint_auth_method: "none",
  });
  const pending = provider.begin({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri,
    resource: `${origin}/mcp`,
    scope,
    state: "test",
    code_challenge: oauthDigest(secret),
    code_challenge_method: "S256",
  });
  const redirected = new URL(
    provider.approve(
      {
        transaction: pending.transaction,
        decision: "approve",
        pairing_secret: secret,
      },
      pending.cookie,
    ),
  );
  return provider.token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri,
    resource: `${origin}/mcp`,
    code: redirected.searchParams.get("code"),
    code_verifier: secret,
  }).access_token;
}
async function fixture() {
  const f = await recoveryLibrary();
  const { McpPageEditService } =
    await import("../src/main/application/mcpPageEditService");
  const { createMcpPageEditScope } =
    await import("../src/main/mcp/mcpPageEditScope");
  const { createMcpPageEditTools } =
    await import("../src/main/mcp/mcpPageEditTools");
  const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
  const { getAppPaths } = await import("../src/main/appPaths");
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const jobs = new ActiveJobStore({ info: vi.fn(), error: vi.fn() });
  const stop = jobs.pageHandoffs.subscribe(() => {
    for (const item of jobs.pageHandoffs.activities)
      if (item.phase === "finishing-edits" && item.requestId)
        jobs.pageHandoffs.respond({ requestId: item.requestId });
  });
  const app = {
    jobs,
    appPaths: getAppPaths(),
    inpaintingRevisionStore: f.store,
    getMainWindow: () => null,
    decodeImage: async () => null,
  };
  const notifySaved = vi.fn();
  const service = new McpPageEditService({
    openChapter: f.library.openChapter,
    savePageBlocks: f.library.savePageBlocks,
    assertWritable: async () => {},
    notifySaved,
    withPageEdit: createMcpPageEditScope(app, f.library.openChapter),
  });
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowProcessing: true,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const full = grant(provider, "carrot.read carrot.edit carrot.process");
  const read = grant(provider, "carrot.read");
  const errors: unknown[] = [];
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: createMcpPageEditTools(service, true, true),
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session,
      pairing: new McpPairingBroker(provider, secret),
    }),
    reportError: (error) => errors.push(error),
  });
  const rpc = async (method: string, params = {}, bearer = full) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  const request = {
    ...f.target,
    revision: createPageRevision(f.after),
    sourceRect: { x: 250.5, y: 300.25, w: 130.5, h: 140.25 },
  };
  return {
    ...f,
    jobs,
    errors,
    notifySaved,
    request,
    read,
    rpc,
    call: async (args: unknown, bearer = full) =>
      (await rpc("tools/call", { name, arguments: args }, bearer)).body,
    close: async () => {
      await server.close();
      stop();
      await f.close();
    },
  };
}

it("saves fractional source bounds over scoped HTTP while retaining image bytes and non-target data", async () => {
  const f = await fixture();
  try {
    const before = (await f.library.openChapter("chapter")).pages[0];
    const raster = await readFile(f.output);
    const response = await f.call(f.request);
    expect(response.result.isError).toBe(false);
    expect(response.result.content).toHaveLength(1);
    const result = response.result.structuredContent;
    expect(JSON.parse(response.result.content[0].text)).toEqual(result);
    expect(result).toMatchObject({
      status: "saved",
      changed: true,
      sourceRect: f.request.sourceRect,
    });
    expect(JSON.stringify(response)).not.toMatch(
      /image\/png|resource_link|dataUrl|sourceText/,
    );
    expect(JSON.stringify(response)).not.toContain(f.environment.root);
    const saved = (await f.library.openChapter("chapter")).pages[0];
    expect(saved.blocks).toEqual([
      {
        ...before.blocks[0],
        bbox: result.sourceBbox,
        bboxSpace: "normalized_1000",
      },
      before.blocks[1],
    ]);
    expect(saved.blockOrder).toEqual(before.blockOrder);
    expect(saved.inpaintedImagePath).toBe(before.inpaintedImagePath);
    expect(await readFile(f.output)).toEqual(raster);
    expect(await readFile(f.original, "utf8")).toBe("original-pixels");
    const snapshot = await f.snapshot();
    expect((await f.call(f.request)).result.structuredContent.error).toBe(
      "revision_conflict",
    );
    const repeated = await f.call({ ...f.request, revision: result.revision });
    expect(repeated.result.structuredContent).toMatchObject({
      status: "already_applied",
      changed: false,
    });
    expect(await f.snapshot()).toEqual(snapshot);
    expect(
      (
        await f.call({
          ...f.request,
          revision: result.revision,
          sourceRect: result.previousSourceRect,
        })
      ).result.isError,
    ).toBe(false);
    expect((await f.library.openChapter("chapter")).pages[0].blocks).toEqual(
      before.blocks,
    );
    expect(f.jobs.gate.activities).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("hides writes from read-only grants and rejects malicious or off-page inputs without mutation", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const listed = await f.rpc("tools/list", {}, f.read);
    expect(
      listed.body.result.tools.some(
        (tool: { name: string }) => tool.name === name,
      ),
    ).toBe(false);
    expect((await f.call(f.request, f.read)).error.code).toBe(-32601);
    const full = await f.rpc("tools/list");
    const tool = full.body.result.tools.find(
      (item: { name: string }) => item.name === name,
    );
    expect(tool.outputSchema).toMatchObject({ type: "object" });
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect((await f.rpc("tools/list", {}, "invalid-token")).status).toBe(401);
    const injected = await f.call({ ...f.request, force: true });
    expect(injected.error.code).toBe(-32602);
    const offPage = await f.call({
      ...f.request,
      sourceRect: { x: 999, y: 0, w: 2, h: 10 },
    });
    expect(offPage.result.structuredContent.error).toBe("invalid_edit");
    expect(
      (await f.call({ ...f.request, blockId: "missing" })).result
        .structuredContent.error,
    ).toBe("not_found");
    expect(await f.snapshot()).toEqual(before);
    expect(f.notifySaved).not.toHaveBeenCalled();
    expect(f.jobs.gate.activities).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
