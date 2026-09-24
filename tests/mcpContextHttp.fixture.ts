import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { recoveryLibrary } from "./mcpErasureRecovery.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { createWorkContextResearchFingerprint } from "../src/shared/workContextResearchProposal";
import type { researchWorkContext } from "../src/main/workContextResearch";

export async function contextHttpFixture() {
  const f = await recoveryLibrary();
  const { McpContextProposalService } =
    await import("../src/main/application/mcpContextProposalService");
  const { withMcpContextEditScope } =
    await import("../src/main/mcp/mcpContextEditScope");
  const { createMcpContextEditingTools } =
    await import("../src/main/mcp/mcpContextTools");
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { createMcpContextResearchExecutor } =
    await import("../src/main/mcp/mcpContextResearchAdapter");
  const { createMcpContextResearchTool } =
    await import("../src/main/mcp/mcpContextResearchTool");
  const { createMcpOperationTools } =
    await import("../src/main/mcp/mcpOperationTools");
  const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
  const { getAppPaths } = await import("../src/main/appPaths");
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const jobs = new ActiveJobStore({ info: vi.fn(), error: vi.fn() });
  const { libraryMutationCoordinator } =
    await import("../src/main/libraryStore/libraryMutationCoordinator");
  libraryMutationCoordinator.configureActivityGate(jobs.gate);
  const app = {
    jobs,
    appPaths: getAppPaths(),
    getMainWindow: () => null,
    decodeImage: async () => null,
  };
  const proposals = new McpContextProposalService({
    read: f.library.readWorkContextForEdit,
    commit: f.library.commitWorkContextEdit,
    withEdit: withMcpContextEditScope,
  });
  let journal: unknown = null;
  const persistence = {
    load: async () => structuredClone(journal),
    save: async (value: unknown) => {
      journal = structuredClone(value);
    },
  };
  const errors: unknown[] = [];
  const operations = new McpOperationService(
    (error) => errors.push(error),
    Date.now,
    persistence,
  );
  // Only the internet/model boundary is substituted; storage, leases, result
  // conversion, authorization, JSON-RPC and transaction publication are real.
  const research = vi.fn<typeof researchWorkContext>(async (request) => ({
    engine: request.engine,
    baseFingerprint: createWorkContextResearchFingerprint(
      request.guideSnapshot,
    ),
    operations: [
      {
        id: "operation-1",
        entity: "glossary",
        action: "add",
        reason: "Synthetic referenced result",
        confidence: "high",
        selectedByDefault: true,
        evidence: { pageCount: 1, mentionCount: 1 },
        sources: [
          { title: "Synthetic evidence", url: "https://example.com/reference" },
        ],
        after: {
          id: "research-entry",
          source: "Research hero",
          target: "Reviewed hero",
          category: "term",
          enabled: true,
          origin: "ai",
          createdAt: "2026-09-17T00:00:00.000Z",
          updatedAt: "2026-09-17T00:00:00.000Z",
        },
      },
    ],
    warnings: [],
    stats: {
      queryCount: 1,
      sourceCount: 1,
      tavilyCreditsUsed: 1,
      estimatedTokenDelta: 10,
      elapsedMs: 1,
    },
  }));
  const origin = "https://context-review.test.ts.net",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowProcessing: true,
    allowEdits: true,
  });
  const session = new McpOAuthSession(provider, { save: async () => {} });
  const grant = createMcpTestGrant(origin, secret);
  const full = grant(provider, "carrot.read carrot.edit carrot.process"),
    read = grant(provider, "carrot.read"),
    other = grant(provider, "carrot.read carrot.edit carrot.process");
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools: [
      ...createMcpContextEditingTools(proposals, true),
      ...createMcpOperationTools(operations, {}),
      createMcpContextResearchTool(
        operations,
        createMcpContextResearchExecutor(app, proposals, research),
      ),
    ],
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session,
      pairing: new McpPairingBroker(provider, secret),
    }),
    reportError: (error) => errors.push(error),
  });
  const rpc = async (
    method: string,
    params: unknown = {},
    token = full,
    signal?: AbortSignal,
  ) => {
    const response = await fetch(server.url, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return response.json();
  };
  const call = (
    name: string,
    args: unknown,
    token = full,
    signal?: AbortSignal,
  ) => rpc("tools/call", { name, arguments: args }, token, signal);
  const settle = async (jobId: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await call("carrot_get_job", { jobId });
      if (!response.result || response.result.isError)
        throw new Error(JSON.stringify(response));
      const job = response.result.structuredContent;
      if (job.status !== "running") return job;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Research fixture did not settle");
  };
  return {
    ...f,
    proposals,
    operations,
    jobs,
    research,
    errors,
    call,
    rpc,
    settle,
    read,
    other,
    full,
    provider,
    target: {
      chapterId: "chapter",
      revision: mcpContextRevision(
        await f.library.readWorkContextForEdit("chapter"),
      ),
      requestId: randomUUID(),
      researchTitle: "Synthetic work",
      engine: "tavily" as const,
    },
    stored: () => journal,
    restart: async () => {
      const next = new McpOperationService(
        (error) => errors.push(error),
        Date.now,
        persistence,
      );
      await next.ready();
      return next;
    },
    async close() {
      operations.stop();
      proposals.stop();
      await operations.close();
      await proposals.close();
      await server.close();
      libraryMutationCoordinator.configureActivityGate(null);
      await f.close();
    },
  };
}
