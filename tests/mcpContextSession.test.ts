import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { recoveryLibrary } from "./mcpErasureRecovery.fixture";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";

it.each([true, false])("composes context tools with editing/processing=%s and closes its proposals", async (enabled) => {
  const f = await recoveryLibrary();
  const { createMcpContextSession } = await import("../src/main/mcp/mcpContextSession");
  const { McpOperationService } = await import("../src/main/application/mcpOperationService");
  const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
  const { getAppPaths } = await import("../src/main/appPaths");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const errors: unknown[] = [];
  const operations = new McpOperationService((error) => errors.push(error));
  const session = createMcpContextSession({
    appPaths: getAppPaths(), jobs: new ActiveJobStore(),
    getMainWindow: () => null, decodeImage: async () => null,
  }, operations, { allowImages: false, allowEditing: enabled, allowProcessing: enabled, autoStart: false });
  const authorize = () => {};
  const context = { principalId: "session-owner", assertAuthorized: authorize, assertScopes: authorize };
  try {
    const names = session.tools.map((tool) => tool.name);
    expect(names.includes("carrot_apply_context_proposal")).toBe(enabled);
    expect(names.includes("carrot_run_context_research")).toBe(enabled);
    expect(names).toEqual(expect.arrayContaining(["carrot_preview_context_edit", "carrot_preview_context_research", "carrot_get_context_proposal"]));
    const before = await f.library.readWorkContextForEdit("chapter");
    const preview = session.tools.find((tool) => tool.name === "carrot_preview_context_edit");
    const inspect = session.tools.find((tool) => tool.name === "carrot_get_context_proposal");
    if (!preview || !inspect) throw new Error("Missing context tools");
    const request = { chapterId: "chapter", revision: mcpContextRevision(before), requestId: randomUUID(), changes: [{ changeId: "rule", entity: "rules", values: { sfxMode: "note" } }] };
    const proposal = mcpToolResult(preview, await preview.invoke(request, context));
    expect(proposal.isError).toBe(false);
    const receipt = JSON.parse(proposal.content[0].type === "text" ? proposal.content[0].text : "null");
    const reviewed = mcpToolResult(inspect, await inspect.invoke({ proposalId: receipt.proposalId }, context));
    expect(reviewed.isError).toBe(false);
    expect(mcpContextRevision(await f.library.readWorkContextForEdit("chapter"))).toBe(request.revision);
    session.stop();
    await expect(preview.invoke({ ...request, requestId: randomUUID() }, context)).rejects.toThrow();
    expect(errors).toEqual([]);
  } finally {
    await session.close();
    await operations.close();
    await f.close();
  }
});
