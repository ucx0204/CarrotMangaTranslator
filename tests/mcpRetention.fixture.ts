import { vi } from "vitest";
import { randomUUID } from "node:crypto";
import { imageEditingFixture } from "./mcpImageEditing.fixture";
import { mcpTestEncryption } from "./mcpEncryption.fixture";
import {
  mcpRetentionOutputs,
  type McpRecoveryAction,
} from "../src/shared/mcpRetention";
import { createPageRevision } from "../src/shared/pageRevision";
import {
  mcpImageEditOutputs,
  type McpImageEditCommand,
} from "../src/shared/mcpImageEditing";

export async function retentionFixture() {
  const f = await imageEditingFixture();
  const { McpSecureStore } = await import("../src/main/mcp/mcpSecureStore");
  const { createMcpPageOperationSession } =
    await import("../src/main/mcp/mcpPageOperationSession");
  const { createMcpAppTools } = await import("../src/main/mcp/mcpAppTools");
  const { createMcpPageEditScope } =
    await import("../src/main/mcp/mcpPageEditScope");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const { McpRetentionStorage } =
    await import("../src/main/mcp/mcpRetentionStorage");
  const encryption = mcpTestEncryption();
  const secure = new McpSecureStore(f.env.root, encryption);
  const codec = secure.retentionCodec();
  const errors: unknown[] = [];
  const preferences = {
    allowEditing: true,
    allowProcessing: true,
    allowImages: true,
    autoStart: false,
  };
  const editing = { ...f.editing, assertClean: f.editing.assertWritable };
  const open = () => {
    const operations = createMcpPageOperationSession({
      origin: "http://127.0.0.1:38554",
      app: f.app,
      editing,
      preferences,
      retentionCodec: new McpSecureStore(
        f.env.root,
        encryption,
      ).retentionCodec(),
      reportError: (error) => errors.push(error),
    });
    const lifetime = new AbortController();
    const tools = createMcpAppTools({
      ...editing,
      preferences,
      additionalTools: operations.tools,
      lifetime: lifetime.signal,
      withPageEdit: createMcpPageEditScope(
        f.app,
        f.library.openChapter,
        lifetime.signal,
      ),
      wrapTool: operations.wrapTool,
    });
    return { operations, tools, lifetime };
  };
  let current = open();
  await current.operations.ready();
  const invoke = async (name: string, args: object, caller = f.auth()) => {
    const tool = current.tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Missing retained tool ${name}`);
    const response = mcpToolResult(
      tool,
      await tool.invoke(args as Record<string, unknown>, caller),
    );
    if (response.isError)
      throw new Error(JSON.stringify(response.structuredContent));
    return response;
  };
  const list = async (
    kind: "changes" | "outputs" = "changes",
    args: object = {},
  ) =>
    mcpRetentionOutputs.carrot_list_changes.parse(
      (await invoke(`carrot_list_${kind}`, args)).structuredContent,
    );
  const inspect = async (id: string) =>
    mcpRetentionOutputs.carrot_get_change.parse(
      (await invoke("carrot_get_change", { id })).structuredContent,
    );
  const actionInput = async (id: string): Promise<McpRecoveryAction> => ({
    id,
    requestId: randomUUID(),
    pages: (await inspect(id)).pages.map(
      ({ chapterId, pageId, revision, reviewRevision }) => ({
        chapterId,
        pageId,
        revision,
        reviewRevision,
      }),
    ),
  });
  const recover = async (
    id: string,
    direction: "undo" | "redo",
    input?: McpRecoveryAction,
  ) =>
    mcpRetentionOutputs.carrot_undo_change.parse(
      (
        await invoke(
          `carrot_${direction}_change`,
          input ?? (await actionInput(id)),
        )
      ).structuredContent,
    );
  const edit = async (translatedText: string) => {
    const page = (await f.snapshot()).pages[0];
    return invoke("carrot_update_page_blocks", {
      chapterId: "chapter",
      pageId: page.id,
      revision: createPageRevision(page),
      edits: [{ blockId: page.blocks[0].id, fields: { translatedText } }],
    });
  };
  const paint = async (
    command: McpImageEditCommand = {
      kind: "paint",
      geometry: {
        kind: "rectangle",
        start: { x: 10, y: 10 },
        end: { x: 20, y: 20 },
      },
      protectedAreas: [],
      color: "#334455",
    },
  ) => {
    const plan = mcpImageEditOutputs.carrot_preview_image_edit.parse(
      (await invoke("carrot_preview_image_edit", await f.input(command)))
        .structuredContent,
    );
    await invoke("carrot_apply_image_edit", {
      batchId: plan.batchId,
      requestId: randomUUID(),
    });
    await vi.waitFor(
      async () => {
        const view = mcpImageEditOutputs.carrot_get_image_edit.parse(
          (await invoke("carrot_get_image_edit", { batchId: plan.batchId }))
            .structuredContent,
        );
        expectTerminal(view.status);
      },
      { timeout: 10000 },
    );
    return mcpImageEditOutputs.carrot_get_image_edit.parse(
      (await invoke("carrot_get_image_edit", { batchId: plan.batchId }))
        .structuredContent,
    );
  };
  const closeCurrent = async () => {
    current.lifetime.abort();
    await current.operations.close();
  };
  return {
    ...f,
    codec,
    encryption,
    secure,
    storage: new McpRetentionStorage(codec),
    errors,
    invoke,
    list,
    inspect,
    actionInput,
    recover,
    edit,
    paint,
    operations: () => current.operations,
    tools: () => current.tools,
    restart: async () => {
      await closeCurrent();
      current = open();
      await current.operations.ready();
    },
    close: async () => {
      await closeCurrent();
      await f.close();
    },
  };
}
function expectTerminal(status: string) {
  if (status === "running") throw new Error("Native image edit is running");
}
