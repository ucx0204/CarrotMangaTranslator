import type { McpTool } from "../src/main/mcp/mcpReadTools";
import type { McpPageEditService as PageEditor } from "../src/main/application/mcpPageEditService";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { createPageRevision } from "../src/shared/pageRevision";
import { recoveryLibrary } from "./mcpErasureRecovery.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

export async function structureHttpFixture(
  extensions?: (
    service: PageEditor,
    lifetime: AbortSignal,
  ) => McpTool[] | Promise<McpTool[]>,
) {
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
  const { libraryMutationCoordinator } =
    await import("../src/main/libraryStore/libraryMutationCoordinator");
  const jobs = new ActiveJobStore({ info: vi.fn(), error: vi.fn() });
  libraryMutationCoordinator.configureActivityGate(jobs.gate);
  const acknowledge = jobs.pageHandoffs.subscribe(() => {
    for (const item of jobs.pageHandoffs.activities)
      if (item.phase === "finishing-edits" && item.requestId)
        jobs.pageHandoffs.respond({ requestId: item.requestId });
  });
  const lifetime = new AbortController();
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
    withPageEdit: createMcpPageEditScope(
      app,
      f.library.openChapter,
      lifetime.signal,
    ),
  });
  const origin = "https://structure.test.ts.net",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowProcessing: true,
    allowEdits: true,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const grant = createMcpTestGrant(origin, secret);
  const full = grant(provider, "carrot.read carrot.edit carrot.process");
  const read = grant(provider, "carrot.read");
  const other = grant(provider, "carrot.read carrot.edit carrot.process");
  const errors: unknown[] = [];
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: [
      ...createMcpPageEditTools(service, true, true, lifetime.signal),
      ...((await extensions?.(service, lifetime.signal)) ?? []),
    ],
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session,
      pairing: new McpPairingBroker(provider, secret),
    }),
    reportError: (error) => errors.push(error),
  });
  const rpc = async (method: string, params: unknown = {}, bearer = full) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return response.json();
  };
  return {
    ...f,
    jobs,
    notifySaved,
    errors,
    read,
    other,
    full,
    provider,
    rpc,
    request: {
      chapterId: "chapter",
      pageId: "page",
      revision: createPageRevision(f.after),
      requestId: randomUUID(),
      reason: "The AI identified an unwanted duplicate text object",
      operation: { kind: "delete", blockId: "a" },
    },
    call: (name: string, args: unknown, bearer = full) =>
      rpc("tools/call", { name, arguments: args }, bearer),
    close: async () => {
      lifetime.abort();
      await server.close();
      acknowledge();
      libraryMutationCoordinator.configureActivityGate(null);
      await f.close();
    },
  };
}
