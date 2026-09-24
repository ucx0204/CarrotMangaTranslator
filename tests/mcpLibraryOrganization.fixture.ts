import { randomUUID } from "node:crypto";
import { importDuplicateFixture } from "./mcpImportDuplicate.fixture";
import type { McpLibraryOrganizationIntent } from "../src/shared/mcpLibraryOrganization";
import { mcpLibraryOrganizationOutputs } from "../src/shared/mcpLibraryOrganization";

export async function libraryOrganizationFixture(
  notify?: (
    event: import("../src/shared/mcpEditingTypes").McpLibraryChangedEvent,
  ) => void,
) {
  const f = await importDuplicateFixture();
  const { createMcpLibraryOrganizationSession } =
    await import("../src/main/mcp/mcpLibraryOrganizationSession");
  const { McpRetentionCatalog } =
    await import("../src/main/mcp/mcpRetentionCatalog");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const open = () =>
    createMcpLibraryOrganizationSession(f.storage, f.preferences, notify);
  let session = open();
  const call = async (name: string, input: object, caller = f.auth()) => {
    const tool = session.tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    const result = mcpToolResult(
      tool,
      await tool.invoke(input as Record<string, unknown>, caller),
    );
    if (result.isError)
      throw new Error(JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  const preview = async (intent: McpLibraryOrganizationIntent) =>
    mcpLibraryOrganizationOutputs.carrot_preview_library_change.parse(
      await call("carrot_preview_library_change", { intent }),
    );
  const command = async (intent: McpLibraryOrganizationIntent) => {
    const review = await preview(intent);
    return {
      intent: review.intent,
      snapshot: review.snapshot,
      planFingerprint: review.planFingerprint,
      requestId: randomUUID(),
    };
  };
  const inspect = async (id: string) =>
    mcpLibraryOrganizationOutputs.carrot_get_library_change.parse(
      await call("carrot_get_library_change", { id }),
    );
  const apply = async (input: Awaited<ReturnType<typeof command>>) =>
    mcpLibraryOrganizationOutputs.carrot_apply_library_change.parse(
      await call("carrot_apply_library_change", input),
    );
  const recover = async (id: string, direction: "undo" | "redo") => {
    const view = await inspect(id);
    const input = { id, snapshot: view.snapshot, requestId: randomUUID() };
    const receipt = await call(`carrot_${direction}_library_change`, input);
    return { input, receipt };
  };
  return {
    ...f,
    importCommand: f.command,
    call,
    preview,
    command,
    inspectChange: inspect,
    apply,
    recover,
    organization: () => session,
    discardChange: (id: string) =>
      new McpRetentionCatalog(
        f.storage,
        new AbortController().signal,
        false,
      ).discard("import-owner", id, () => {}),
    restart: async () => {
      await session.close();
      await f.restart();
      session = open();
    },
    close: async () => {
      await session.close();
      await f.close();
    },
  };
}
