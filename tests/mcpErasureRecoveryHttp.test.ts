import { McpOAuthSession } from "../src/main/mcp/mcpOAuthSession";
import { McpPairingBroker } from "../src/main/mcp/mcpPairingBroker";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { recoveryLibrary } from "./mcpErasureRecovery.fixture";
import { McpOperationService } from "../src/main/application/mcpOperationService";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { McpOAuthHttp } from "../src/main/mcp/mcpOAuthHttp";
import { oauthDigest } from "../src/main/mcp/mcpOAuthPolicy";
import { startMcpHttpServer } from "../src/main/mcp/mcpHttpServer";
import { createPageRevision } from "../src/shared/pageRevision";

const origin = "https://recovery.test.ts.net";
const secret = "a".repeat(43);
function mint(provider: McpOAuthProvider, scope: string) {
  const callback = "https://chatgpt.com/connector/oauth/recovery-test";
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
  return provider.token({
    client_id: client.client_id,
    grant_type: "authorization_code",
    redirect_uri: callback,
    resource: `${origin}/mcp`,
    code: redirect.searchParams.get("code"),
    code_verifier: secret,
  }).access_token;
}
async function fixture() {
  const f = await recoveryLibrary();
  const { getAppPaths } = await import("../src/main/appPaths");
  const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
  const { createMcpErasureRecoverySession } =
    await import("../src/main/mcp/mcpErasureRecoverySession");
  const app = {
    appPaths: getAppPaths(),
    jobs: new ActiveJobStore({ error: vi.fn(), info: vi.fn() }),
    getMainWindow: () => null,
    decodeImage: async () => null,
    inpaintingRevisionStore: f.store,
  };
  const unsubscribe = app.jobs.pageHandoffs.subscribe(() => {
    for (const entry of app.jobs.pageHandoffs.activities)
      if (entry.phase === "finishing-edits" && entry.requestId)
        app.jobs.pageHandoffs.respond({ requestId: entry.requestId });
  });
  const operations = new McpOperationService(() => {});
  const recovery = createMcpErasureRecoverySession(app, operations, () => {});
  if (!recovery) throw new Error("Native recovery not composed");
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowProcessing: true,
  });
  const oauthSession = new McpOAuthSession(provider, { save: async () => {} });
  const oauth = new McpOAuthHttp(origin, secret, {
    session: oauthSession,
    pairing: new McpPairingBroker(provider, secret),
  });
  const token = mint(oauth.provider, "carrot.read carrot.process");
  const owner = oauth.provider.connectionIdFor(`Bearer ${token}`);
  if (!owner) throw new Error("No approved grant");
  const started = await operations.start({
    owner,
    requestId: randomUUID(),
    kind: "erase",
    parameters: {
      ...f.target,
      revision: createPageRevision(f.before),
      requestId: randomUUID(),
    },
    assertAuthorized: () => {},
    execute: async () => ({ pagesChanged: 1, blocksErased: 1 }),
  });
  recovery.remember(started.jobId, f.transactionId);
  await vi.waitFor(() =>
    expect(operations.status(started.jobId, owner).status).toBe("completed"),
  );
  const errors: unknown[] = [];
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: recovery.tools,
    oauthHttp: oauth,
    enforceScopes: true,
    reportError: (error) => errors.push(error),
  });
  const call = async (name: string, args: unknown, bearer = token) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
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
    ...f,
    operations,
    recovery,
    app,
    oauth,
    token,
    owner,
    jobId: started.jobId,
    call,
    errors,
    close: async () => {
      recovery.stop();
      operations.stop();
      await recovery.close();
      await operations.close();
      await server.close();
      unsubscribe();
      await f.close();
    },
  };
}

it("uses strict metadata-only recovery over real HTTP and saves undo/redo through the real page lease", async () => {
  const f = await fixture();
  try {
    const lookup = await f.call("carrot_get_erasure_recovery", {
      jobId: f.jobId,
    });
    expect(lookup.result.isError).toBe(false);
    expect(lookup.result.structuredContent).toMatchObject({
      canUndo: true,
      canRedo: false,
      sessionOnly: true,
    });
    const undo = {
      jobId: f.jobId,
      revision: lookup.result.structuredContent.revision,
      requestId: randomUUID(),
    };
    const reverted = await f.call("carrot_undo_erasure", undo);
    expect(reverted.result.isError).toBe(false);
    expect(reverted.result.structuredContent.pagesChanged).toBe(1);
    const duplicate = await f.call("carrot_undo_erasure", undo);
    expect(duplicate.result.structuredContent).toMatchObject({
      pagesChanged: 0,
      status: "already_applied",
    });
    const inspected = await f.call("carrot_get_erasure_recovery", {
      jobId: f.jobId,
    });
    expect(inspected.result.structuredContent.canRedo).toBe(true);
    const redone = await f.call("carrot_redo_erasure", {
      ...undo,
      requestId: randomUUID(),
      revision: inspected.result.structuredContent.revision,
    });
    expect(redone.result.isError).toBe(false);
    expect(redone.result.structuredContent.pagesChanged).toBe(1);
    const staleRetry = await f.call("carrot_undo_erasure", undo);
    expect(staleRetry.result.structuredContent.pagesChanged).toBe(0);
    expect(await f.inspect()).toMatchObject({ state: "applied" });
    for (const result of [
      lookup,
      reverted,
      duplicate,
      inspected,
      redone,
      staleRetry,
    ]) {
      expect(result.result.content).toHaveLength(1);
      expect(JSON.parse(result.result.content[0].text)).toEqual(
        result.result.structuredContent,
      );
      expect(JSON.stringify(result)).not.toMatch(
        /transactionId|original-pixels|resource_link|mcp-artifacts|image\/png/,
      );
      expect(JSON.stringify(result)).not.toContain(f.environment.root);
    }
    expect(f.app.jobs.gate.activities).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rejects other grants, read-only writes, injected targets and malformed input without any save", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.snapshot();
    const stranger = mint(f.oauth.provider, "carrot.read carrot.process");
    const readOnly = mint(f.oauth.provider, "carrot.read");
    const action = {
      jobId: f.jobId,
      revision: createPageRevision(f.after),
      requestId: randomUUID(),
    };
    expect(
      (
        await f.call(
          "carrot_get_erasure_recovery",
          { jobId: f.jobId },
          stranger,
        )
      ).result.isError,
    ).toBe(true);
    expect(
      (await f.call("carrot_undo_erasure", action, readOnly)).error.code,
    ).toBe(-32602);
    for (const args of [
      null,
      [],
      { ...action, transactionId: f.transactionId },
      { ...action, pageId: "other" },
      { ...action, direction: "redo" },
      { ...action, revision: "bad" },
    ]) {
      const rejected = await f.call("carrot_undo_erasure", args);
      expect(rejected.error ?? rejected.result?.isError).toBeTruthy();
      expect(rejected.result?.isError).not.toBe(false);
    }
    expect(await f.snapshot()).toEqual(snapshot);
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});
