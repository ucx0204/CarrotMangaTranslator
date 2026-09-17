import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { structureHttpFixture } from "./mcpStructureHttp.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";

async function fixture() {
  const f = await structureHttpFixture(async (service, lifetime) => {
    const { createMcpTranslationBatchPorts } =
      await import("../src/main/mcp/mcpTranslationBatchAdapter");
    const { createMcpTranslationBatchTools } =
      await import("../src/main/mcp/mcpTranslationBatchTools");
    return createMcpTranslationBatchTools(
      createMcpTranslationBatchPorts(service),
      true,
      lifetime,
    );
  });
  // Populate only this isolated test root. Normal writes below use the real app facade.
  const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
  chapter.pages = [
    chapter.pages[0],
    { ...structuredClone(chapter.pages[0]), id: "page-two" },
  ];
  chapter.pageOrder = chapter.pages.map((page: { id: string }) => page.id);
  await writeFile(f.chapterPath, JSON.stringify(chapter));
  const request = async () => {
    const saved = await f.library.readWorkContextForEdit("chapter");
    return {
      chapterId: "chapter",
      contextRevision: mcpContextRevision(saved),
      requestId: randomUUID(),
      reason: "Unify name spelling",
      pages: saved.chapter.pages.map((page) => ({
        pageId: page.id,
        revision: createPageRevision(page),
        edits: [
          {
            blockId: "a",
            translatedText: "리오가 왔다.",
            reason: "Same character",
          },
        ],
      })),
    };
  };
  const done = async (batchId: string) => {
    for (let index = 0; index < 200; index++) {
      const response = await f.call("carrot_get_translation_batch", {
        batchId,
      });
      expect(response.result.isError).toBe(false);
      if (response.result.structuredContent.status !== "running")
        return response.result.structuredContent;
      await delay(5);
    }
    throw new Error("HTTP batch did not settle");
  };
  return { ...f, request, done };
}
it("authenticates search and exact batch edits, with real read leases, persistence and reversible text", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const saved = await f.library.openChapter("chapter");
    const search = await f.call(
      "carrot_search_chapter_text",
      { chapterId: "chapter", mode: "browse", limit: 1 },
      f.read,
    );
    expect(search.result.isError).toBe(false);
    expect(search.result.structuredContent.total).toBe(4);
    const input = await f.request();
    const denied = await f.call(
      "carrot_preview_translation_batch",
      input,
      f.read,
    );
    expect(denied.error).toBeDefined();
    expect(denied.result).toBeUndefined();
    const preview = await f.call("carrot_preview_translation_batch", input);
    expect(preview.result.isError).toBe(false);
    const batchId = preview.result.structuredContent.batchId;
    expect(await f.snapshot()).toEqual(before);
    expect(
      (await f.call("carrot_get_translation_batch", { batchId }, f.other))
        .result.isError,
    ).toBe(true);
    const apply = { batchId, requestId: randomUUID() };
    expect(
      (await f.call("carrot_apply_translation_batch", apply)).result
        .structuredContent.status,
    ).toBe("accepted");
    expect((await f.done(batchId)).status).toBe("completed");
    expect(
      (await f.library.openChapter("chapter")).pages.map(
        (page) => page.blocks[0].translatedText,
      ),
    ).toEqual(["리오가 왔다.", "리오가 왔다."]);
    const undo = { batchId, requestId: randomUUID() };
    await f.call("carrot_undo_translation_batch", undo);
    await f.done(batchId);
    const restored = await f.library.openChapter("chapter");
    expect(restored.pages.map((page) => page.blocks)).toEqual(
      saved.pages.map((page) => page.blocks),
    );
    expect(restored.pages.map((page) => page.blockOrder)).toEqual(
      saved.pages.map((page) => page.blockOrder),
    );
    const replay = await f.call("carrot_apply_translation_batch", apply);
    expect(replay.result.structuredContent.historical).toBe(true);
    expect((await f.snapshot()).original).toBe(before.original);
    expect(JSON.stringify(preview)).not.toMatch(
      /imagePath|dataUrl|resource_link/,
    );
  } finally {
    await f.close();
  }
});
it("does not write any page with a stale saved-context revision", async () => {
  const f = await fixture();
  try {
    const input = await f.request();
    const plan = (await f.call("carrot_preview_translation_batch", input))
      .result.structuredContent;
    const context = await f.library.readWorkContextForEdit("chapter");
    await f.library.saveWorkStyleGuide({
      ...context.styleGuide,
      rules: { ...context.styleGuide.rules, honorifics: "drop" },
    });
    const before = await f.snapshot();
    await f.call("carrot_apply_translation_batch", {
      batchId: plan.batchId,
      requestId: randomUUID(),
    });
    const done = await f.done(plan.batchId);
    expect(done.status).toBe("failed");
    expect(done.pages[0].errorCode).toBe("revision_conflict");
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});
it("partially commits before a later changed page, then undoes only this batch's changes", async () => {
  const f = await fixture();
  try {
    const plan = (
      await f.call("carrot_preview_translation_batch", await f.request())
    ).result.structuredContent;
    const page = (await f.library.openChapter("chapter")).pages[1];
    await f.call("carrot_update_translations", {
      chapterId: "chapter",
      pageId: page.id,
      revision: createPageRevision(page),
      edits: [{ blockId: "b", translatedText: "user edit" }],
    });
    await f.call("carrot_apply_translation_batch", {
      batchId: plan.batchId,
      requestId: randomUUID(),
    });
    const result = await f.done(plan.batchId);
    expect(result.status).toBe("partial");
    expect(result.pages.map((item: { state: string }) => item.state)).toEqual([
      "applied",
      "pending",
    ]);
    await f.call("carrot_undo_translation_batch", {
      batchId: plan.batchId,
      requestId: randomUUID(),
    });
    await f.done(plan.batchId);
    const restored = await f.library.openChapter("chapter");
    expect(restored.pages[0].blocks[0].translatedText).toBe("original-a");
    expect(restored.pages[1].blocks[1].translatedText).toBe("user edit");
  } finally {
    await f.close();
  }
});
