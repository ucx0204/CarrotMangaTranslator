import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";

export async function typographyBatchAppFixture(mode: "font" | "size" | "font-and-size" = "font-and-size") {
  const f = await typographyAnalysisAppFixture();
  const { McpTypographyReadService } = await import("../src/main/application/mcpTypographyReadService");
  const { McpTypographyAnalysisService } = await import("../src/main/application/mcpTypographyAnalysisService");
  const { McpOperationService } = await import("../src/main/application/mcpOperationService");
  const { createMcpTypographyAnalyzer } = await import("../src/main/mcp/mcpTypographyAnalysisAdapter");
  const { createMcpTypographyBatchSession } = await import("../src/main/mcp/mcpTypographyBatchSession");
  const { readMcpFontCatalog } = await import("../src/main/mcp/mcpFontCatalogAdapter");
  const { createPageRevision } = await import("../src/shared/pageRevision");
  const { mcpContextRevision } = await import("../src/shared/mcpContextEditing");
  const owner = "typography-owner";
  const guard = vi.fn();
  const auth = {
    principalId: owner,
    assertAuthorized: guard,
    assertScopes: vi.fn(),
    assertJobAuthorized: guard,
  };
  const preparation = new McpTypographyReadService({
    openChapter: f.library.openChapter,
    readCatalog: () => readMcpFontCatalog(f.app.appPaths),
  });
  const analysis = new McpTypographyAnalysisService({
    read: f.library.readWorkContextForEdit,
    preparation,
    analyze: createMcpTypographyAnalyzer(f.app, f.runtime),
  });
  const errors: unknown[] = [];
  const operations = new McpOperationService((error) => errors.push(error));
  const editing = { assertWritable: vi.fn(async () => {}), notifySaved: vi.fn() };
  const session = createMcpTypographyBatchSession(f.app, operations, editing, true);
  const analyze = async () => {
    const options = {
      chapterId: "chapter", mode, sourceLanguage: "ja", targetLanguage: "ko",
      allowOcr: mode !== "size", preserveManualFontSize: true,
    };
    const preflight = await preparation.preflight(options, guard);
    const target = {
      ...options, snapshot: preflight.snapshot, catalogSnapshot: preflight.catalogSnapshot,
      pages: preflight.pages.map(({ pageId, revision }) => ({ pageId, revision })),
      allowAssetDownloads: mode !== "size", requestId: randomUUID(),
    };
    const receipt = await operations.start({
      owner, kind: "typographyAnalysis", parameters: target, requestId: target.requestId,
      assertAuthorized: guard, execute: (context) => analysis.run(target, context),
    });
    await vi.waitFor(() => {
      const status = operations.status(receipt.jobId, owner);
      if (status.error) throw new Error(JSON.stringify(status.error));
      if (status.status !== "completed") throw new Error("Analysis still pending");
    }, { timeout: 5000 });
    const saved = await f.library.readWorkContextForEdit("chapter");
    return {
      chapterId: "chapter", analysisJobId: receipt.jobId,
      contextRevision: mcpContextRevision(saved), requestId: randomUUID(),
      preserveManualFontSize: true, reason: "Match only selected source typography",
      pages: saved.chapter.pages.map((page) => ({
        pageId: page.id, revision: createPageRevision(page),
        edits: [{ blockId: "a", mode, reason: "Use measured source evidence" }],
      })),
    };
  };
  const invoke = async (name: string, args: Record<string, unknown>, caller = auth) => {
    const tool = session.tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Missing tool: ${name}`);
    const content = await tool.invoke(args, caller);
    if (content.length !== 1 || content[0].type !== "text") throw new Error("Expected text-only result");
    return JSON.parse(content[0].text);
  };
  const inspect = (batchId: string) => invoke("carrot_get_typography_batch", { batchId });
  const done = async (batchId: string) => {
    await vi.waitFor(async () => {
      if ((await inspect(batchId)).status === "running") throw new Error("Batch still running");
    }, { timeout: 5000 });
    return inspect(batchId);
  };
  return {
    ...f, operations, session, editing, errors, owner, auth, guard, analyze, invoke, inspect, done,
    action: (batchId: string, direction: string, requestId = randomUUID()) =>
      invoke(`carrot_${direction}_typography_batch`, { batchId, requestId }),
    close: async () => { await session.close(); await operations.close(); await f.close(); },
  };
}
