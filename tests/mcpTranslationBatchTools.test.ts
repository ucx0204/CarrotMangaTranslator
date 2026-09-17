import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";
import { createMcpTranslationBatchTools } from "../src/main/mcp/mcpTranslationBatchTools";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpBatchMembership } from "../src/main/application/mcpTranslationBatchPolicy";

it("rejects a generated-text block inside the native commit boundary even with its fresh revision", async () => {
  const f = translationBatchFixture();
  const page = f.chapter.pages[0];
  page.blocks[0].generatedLettering = {
    version: 1,
    dataUrl: "PRIVATE",
    sourceText: "source",
    translatedText: "original-a",
  };
  await expect(
    f.edits.commitTranslationBatch(
      {
        chapterId: "chapter",
        pageId: page.id,
        revision: createPageRevision(page),
        edits: [{ blockId: "a", translatedText: "not applied" }],
      },
      mcpBatchMembership(f.chapter),
      f.guard,
      () => {},
      async (run) => run(),
    ),
  ).rejects.toThrow(/Generated lettering/);
  expect(f.save).not.toHaveBeenCalled();
  await f.service.close();
});
it("exposes only text search when editing is disabled and validates ownership/input", async () => {
  const f = translationBatchFixture();
  const tools = createMcpTranslationBatchTools(f.ports, false);
  expect(tools.map((tool) => tool.name)).toEqual([
    "carrot_search_chapter_text",
  ]);
  await expect(
    tools[0].invoke({ chapterId: "chapter", mode: "browse" }),
  ).rejects.toThrow(/approved connection/);
  await expect(
    tools[0].invoke(
      { chapterId: "chapter", mode: "browse", path: "PRIVATE" },
      { principalId: f.owner, assertAuthorized: f.guard },
    ),
  ).rejects.toThrow();
  await f.service.close();
});
it("uses the connection grant after acceptance and cancels the matching asynchronous action", async () => {
  const f = translationBatchFixture();
  const tools = createMcpTranslationBatchTools(
    f.ports,
    true,
    f.lifetime.signal,
  );
  const context = {
    principalId: f.owner,
    assertAuthorized: f.guard,
    assertScopes: vi.fn(),
    assertJobAuthorized: vi.fn(),
  };
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error("Missing test tool");
    const reply = await tool.invoke(args, context);
    expect(reply).toHaveLength(1);
    if (reply[0].type !== "text") throw new Error("Metadata expected");
    return JSON.parse(reply[0].text);
  };
  const preview = await invoke("carrot_preview_translation_batch", f.request());
  const originalSave = f.save.getMockImplementation();
  if (!originalSave) throw new Error("Missing storage fixture");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.save.mockImplementationOnce(async (...args) => {
    await held;
    return originalSave(...args);
  });
  context.assertScopes.mockClear();
  const action = { batchId: preview.batchId, requestId: randomUUID() };
  await invoke("carrot_apply_translation_batch", action);
  await tick();
  expect(context.assertJobAuthorized).toHaveBeenCalled();
  expect(context.assertScopes).not.toHaveBeenCalled();
  const cancelled = await invoke("carrot_cancel_translation_batch", action);
  expect(cancelled.cancellationRequested).toBe(true);
  release();
  let finished = false;
  for (let i = 0; i < 100; i++) {
    await tick();
    const state = await invoke("carrot_get_translation_batch", {
      batchId: preview.batchId,
    });
    if (state.status !== "running") {
      expect(state.status).toBe("cancelled");
      finished = true;
      break;
    }
  }
  expect(finished).toBe(true);
  expect(f.chapter.pages[0].blocks[0].translatedText).toBe("original-a");
  f.lifetime.abort();
  await f.service.close();
});
