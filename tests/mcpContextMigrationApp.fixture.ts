import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { vi } from "vitest";
import { contextReferenceAppFixture } from "./mcpContextReferenceApp.fixture";
import { mcpTestEncryption } from "./mcpEncryption.fixture";
import {
  McpContextMigrationApplySchema,
  mcpContextMigrationOutputs,
} from "../src/shared/mcpContextMigration";

export async function contextMigrationAppFixture() {
  const f = await contextReferenceAppFixture();
  const guide = await f.library.getWorkStyleGuide("work");
  guide.characters[0].origin = "ai";
  guide.characters.push({
    ...guide.characters[0],
    id: "destination",
    displayName: "Destination",
  });
  await f.library.saveWorkStyleGuide(guide);
  const second = JSON.parse(await readFile(f.secondPath, "utf8"));
  second.pages[0].blocks[0].speakerId = "character";
  await writeFile(f.secondPath, JSON.stringify(second));
  const { McpSecureStore } = await import("../src/main/mcp/mcpSecureStore");
  const { McpRetentionStorage } =
    await import("../src/main/mcp/mcpRetentionStorage");
  const { createMcpPageOperationSession } =
    await import("../src/main/mcp/mcpPageOperationSession");
  const { createMcpAppTools } = await import("../src/main/mcp/mcpAppTools");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const { readWorkContextReferences } =
    await import("../src/main/library/libraryContextEditingFacade");
  const encryption = mcpTestEncryption();
  const codec = new McpSecureStore(f.env.root, encryption).retentionCodec();
  const preferences = {
    allowEditing: true,
    allowProcessing: true,
    allowImages: false,
    autoStart: false,
  };
  const editing = {
    assertWritable: vi.fn(async () => {}),
    assertClean: vi.fn(async () => {}),
    notifySaved: vi.fn(),
  };
  const errors: unknown[] = [];
  const open = () => {
    const session = createMcpPageOperationSession({
      app: f.app,
      editing,
      preferences,
      origin: "http://127.0.0.1:38568",
      retentionCodec: codec,
      reportError: (error) => errors.push(error),
    });
    const tools = createMcpAppTools({
      ...editing,
      preferences,
      additionalTools: session.tools,
      wrapTool: session.wrapTool,
    });
    return { session, tools };
  };
  let current = open();
  await current.session.ready();
  const auth = (principalId = "migration-owner") => ({
    principalId,
    assertAuthorized: vi.fn(),
    assertScopes: vi.fn(),
  });
  const invoke = async (name: string, input: object, caller = auth()) => {
    const tool = current.tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Missing migration tool ${name}`);
    const result = mcpToolResult(
      tool,
      await tool.invoke(input as Record<string, unknown>, caller),
    );
    if (result.isError)
      throw new Error(JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  const input = async (
    command: object = {
      kind: "merge",
      entity: "character",
      sourceIds: ["character"],
      targetId: "destination",
    },
  ) => {
    const references = await f.invoke();
    const intent = {
      chapterId: "chapter",
      referenceSnapshot: references.snapshot,
      command,
    };
    const preview =
      mcpContextMigrationOutputs.carrot_preview_context_migration.parse(
        await invoke("carrot_preview_context_migration", intent),
      );
    return McpContextMigrationApplySchema.parse({
      ...intent,
      planFingerprint: preview.planFingerprint,
      requestId: randomUUID(),
    });
  };
  const inspect = async (id: string) =>
    mcpContextMigrationOutputs.carrot_get_context_migration.parse(
      await invoke("carrot_get_context_migration", { id }),
    );
  const recoverInput = async (id: string) => ({
    id,
    requestId: randomUUID(),
    referenceSnapshot: (await inspect(id)).referenceSnapshot,
  });
  const apply = async (args?: Awaited<ReturnType<typeof input>>) =>
    mcpContextMigrationOutputs.carrot_apply_context_migration.parse(
      await invoke("carrot_apply_context_migration", args ?? (await input())),
    );
  const recover = async (id: string, direction: "undo" | "redo") =>
    mcpContextMigrationOutputs.carrot_undo_context_migration.parse(
      await invoke(
        `carrot_${direction}_context_migration`,
        await recoverInput(id),
      ),
    );
  return {
    ...f,
    codec,
    preferences,
    encryption,
    editing,
    errors,
    auth,
    invoke,
    input,
    apply,
    recover,
    recoverInput,
    inspect,
    storage: new McpRetentionStorage(codec),
    current: () => current,
    graph: () => readWorkContextReferences("chapter", () => {}),
    restart: async () => {
      await current.session.close();
      current = open();
      await current.session.ready();
    },
    close: async () => {
      await current.session.close();
      await f.close();
    },
  };
}
