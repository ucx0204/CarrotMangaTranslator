import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";
import { createMcpTestGrant } from "./mcpOAuthGrant.fixture";

async function fixture() {
  const f = await typographyAnalysisAppFixture();
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { McpTypographyReadService } =
    await import("../src/main/application/mcpTypographyReadService");
  const { createMcpTypographyReadTools } =
    await import("../src/main/mcp/mcpTypographyReadTools");
  const { createMcpTypographyAnalysisSession } =
    await import("../src/main/mcp/mcpTypographyAnalysisSession");
  const { readMcpFontCatalog } =
    await import("../src/main/mcp/mcpFontCatalogAdapter");
  const { createMcpOperationTools } =
    await import("../src/main/mcp/mcpOperationTools");
  const { startMcpHttpServer } = await import("../src/main/mcp/mcpHttpServer");
  const { McpOAuthProvider } = await import("../src/main/mcp/mcpOAuthProvider");
  const { McpOAuthSession } = await import("../src/main/mcp/mcpOAuthSession");
  const { McpOAuthHttp } = await import("../src/main/mcp/mcpOAuthHttp");
  const { McpPairingBroker } = await import("../src/main/mcp/mcpPairingBroker");
  const errors: unknown[] = [];
  const jobs = new McpOperationService((error) => errors.push(error));
  const origin = "https://typography-analysis.test",
    secret = "s".repeat(43);
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    allowProcessing: true,
  });
  const auth = new McpOAuthSession(provider, { save: async () => {} });
  const grant = createMcpTestGrant(origin, secret);
  const full = grant(provider, "carrot.read carrot.process"),
    read = grant(provider, "carrot.read");
  const preparation = new McpTypographyReadService({
    openChapter: f.library.openChapter,
    readCatalog: () => readMcpFontCatalog(f.app.appPaths),
    analysisToolAvailable: true,
  });
  expect(
    createMcpTypographyAnalysisSession(f.app, jobs, false, f.runtime),
  ).toEqual([]);
  const tools = [
    ...createMcpTypographyReadTools(preparation),
    ...createMcpTypographyAnalysisSession(f.app, jobs, true, f.runtime),
    ...createMcpOperationTools(jobs, {}),
  ];
  const server = await startMcpHttpServer({
    config: { port: 0, token: "t".repeat(43), publicOrigin: origin },
    tools,
    enforceScopes: true,
    oauthHttp: new McpOAuthHttp(origin, secret, {
      session: auth,
      pairing: new McpPairingBroker(provider, secret),
    }),
    reportError: (error) => errors.push(error),
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
  const request = async () => {
    const options = {
      chapterId: "chapter",
      mode: "font-and-size",
      sourceLanguage: "ja",
      targetLanguage: "ko",
      allowOcr: true,
      preserveManualFontSize: true,
    };
    const response = await call("carrot_preflight_typography", options, read);
    const plan = response.result.structuredContent;
    expect(plan.analysisTool).toBe("carrot_run_typography_analysis");
    return {
      ...options,
      pages: plan.pages.map(
        ({ pageId, revision }: { pageId: string; revision: string }) => ({
          pageId,
          revision,
        }),
      ),
      snapshot: plan.snapshot,
      catalogSnapshot: plan.catalogSnapshot,
      allowAssetDownloads: true,
      requestId: randomUUID(),
    };
  };
  const settle = async (jobId: string) => {
    await vi.waitFor(
      async () => {
        const response = await call("carrot_get_job", { jobId });
        expect(response.result.structuredContent.status).not.toBe("running");
      },
      { timeout: 5000 },
    );
    return (await call("carrot_get_job", { jobId })).result.structuredContent;
  };
  return {
    ...f,
    jobs,
    errors,
    provider,
    auth,
    call,
    request,
    settle,
    read,
    close: async () => {
      await jobs.close();
      await server.close();
      await f.close();
    },
  };
}

it("uses real app leases and structured HTTP job results without changing the saved page", async () => {
  const f = await fixture();
  const before = await readFile(f.chapterPath);
  try {
    const input = await f.request();
    const accepted = await f.call("carrot_run_typography_analysis", input);
    expect(accepted.result.isError).toBe(false);
    expect(
      accepted.result.content.every(
        (item: { type: string }) => item.type === "text",
      ),
    ).toBe(true);
    const id = accepted.result.structuredContent.jobId;
    const completed = await f.settle(id);
    expect(completed.status).toBe("completed");
    expect(completed.result.pagesChanged).toBe(0);
    expect(completed.result.typographyAnalysis.pages).toHaveLength(2);
    expect(
      (await f.call("carrot_run_typography_analysis", input)).result
        .structuredContent.jobId,
    ).toBe(id);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.handoffPages).toEqual(["page", "second"]);
    expect(f.app.jobs.all).toEqual([]);
    expect(f.app.jobs.pageHandoffs.activities).toEqual([]);
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it("denies missing processing authority and rejects unknown arguments before model dispatch", async () => {
  const f = await fixture();
  try {
    const input = await f.request();
    const denied = await f.call(
      "carrot_run_typography_analysis",
      input,
      f.read,
    );
    expect(denied).toMatchObject({
      error: { code: -32602, message: "Unknown tool" },
    });
    const invalid = await f.call("carrot_run_typography_analysis", {
      ...input,
      imagePath: "private",
    });
    expect(invalid.error.code).toBe(-32602);
    expect(f.prepare).not.toHaveBeenCalled();
    const forbiddenOcr = await f.call("carrot_run_typography_analysis", {
      ...input,
      allowAssetDownloads: false,
    });
    const failed = await f.settle(forbiddenOcr.result.structuredContent.jobId);
    expect(failed.status).toBe("failed");
    expect(failed.error.code).toBe("invalid_edit");
    expect(f.prepare).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
