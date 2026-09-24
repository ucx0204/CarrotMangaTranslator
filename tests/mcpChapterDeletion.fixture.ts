import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { chapterDeletionFilesFixture } from "./mcpChapterDeletionFiles.fixture";
import {
  McpChapterDeletionApplySchema,
  mcpChapterDeletionOutputs,
} from "../src/shared/mcpChapterDeletion";
import { McpEditorGuard } from "../src/main/application/mcpEditorGuard";

export async function chapterDeletionFixture(probeAvailable = true) {
  // Multi-chunk behavior remains covered by the unmodified default in byte tests.
  const f = await chapterDeletionFilesFixture(17);
  const { createMcpLibraryOrganizationSession } =
    await import("../src/main/mcp/mcpLibraryOrganizationSession");
  const { McpRetentionCatalog } =
    await import("../src/main/mcp/mcpRetentionCatalog");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const target = { workId: "work", chapterId: "chapter" };
  let openChapter: string | null = null;
  const editor = new McpEditorGuard(
    () => false,
    (probeId) => {
      editor.report({
        probeId,
        chapterId: openChapter,
        dirtyPageIds: [],
        hasPendingInpaintingMask: false,
      });
    },
  );
  const notify = vi.fn();
  const assertClosed = vi.fn((id: string) => editor.assertChapterClosed(id));
  const open = () =>
    createMcpLibraryOrganizationSession(
      f.storage,
      f.preferences,
      notify,
      probeAvailable ? assertClosed : undefined,
    );
  let session = open();
  const call = async (
    name: string,
    input: object,
    caller = f.auth(),
  ): Promise<unknown> => {
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
  const preview = () =>
    call("carrot_preview_chapter_deletion", target).then((value) =>
      mcpChapterDeletionOutputs.carrot_preview_chapter_deletion.parse(value),
    );
  const command = async () =>
    McpChapterDeletionApplySchema.parse({
      ...target,
      snapshot: (await preview()).snapshot,
      requestId: randomUUID(),
      confirm: "delete-chapter-with-seven-day-recovery",
    });
  const apply = async (
    input: Awaited<ReturnType<typeof command>>,
    caller = f.auth(),
  ) =>
    mcpChapterDeletionOutputs.carrot_delete_chapter.parse(
      await call("carrot_delete_chapter", input, caller),
    );
  const inspect = async (id: string) =>
    mcpChapterDeletionOutputs.carrot_get_chapter_deletion.parse(
      await call("carrot_get_chapter_deletion", { id }),
    );
  const recover = async (id: string, direction: "undo" | "redo") => {
    const view = await inspect(id);
    const input = {
      id,
      snapshot: view.snapshot,
      requestId: randomUUID(),
      confirm: true as const,
    };
    const receipt =
      mcpChapterDeletionOutputs.carrot_undo_chapter_deletion.parse(
        await call(`carrot_${direction}_chapter_deletion`, input),
      );
    return { input, receipt };
  };
  const assertOriginal = async () => {
    expect(
      await f.files.captureChapterDeletionTree(f.directory, () => {}),
    ).toEqual(f.tree);
    for (const [path, bytes] of f.original)
      expect(await readFile(join(f.directory, path))).toEqual(bytes);
    expect(
      JSON.parse(
        await readFile(
          join(f.env.libraryDir, "works", "work", "work.json"),
          "utf8",
        ),
      ),
    ).toEqual(f.source.work);
    for (const original of f.originals)
      expect((await readFile(original)).length).toBeGreaterThan(0);
  };
  return {
    ...f,
    importCommand: f.command,
    target,
    notify,
    assertClosed,
    call,
    preview,
    command,
    apply,
    inspect,
    recover,
    assertOriginal,
    organization: () => session,
    editorOpen: (id: string | null) => {
      openChapter = id;
    },
    genericDiscard: (id: string) =>
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
