import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { structureHttpFixture } from "./mcpStructureHttp.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";

async function fixture() {
  const f = await structureHttpFixture(async (service, lifetime) => {
    const { createMcpFormatBatchPorts, createMcpTranslationBatchPorts } =
      await import("../src/main/mcp/mcpTranslationBatchAdapter");
    const { createMcpFormatBatchTools } =
      await import("../src/main/mcp/mcpFormatBatchTools");
    const { createMcpTranslationBatchTools } =
      await import("../src/main/mcp/mcpTranslationBatchTools");
    return [
      ...createMcpFormatBatchTools(
        createMcpFormatBatchPorts(service),
        lifetime,
      ),
      ...createMcpTranslationBatchTools(
        createMcpTranslationBatchPorts(service),
        true,
        lifetime,
      ),
    ];
  });
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
      reason: "AI repairs cramped typography without rewriting dialogue",
      preserveManualFontSize: false,
      pages: saved.chapter.pages.map((page) => ({
        pageId: page.id,
        revision: createPageRevision(page),
        edits: [
          {
            blockId: "a",
            fields: { fontSizePx: 34, bold: true, letterSpacing: 0.05 },
            renderRect: { x: 45, y: 55, w: 170, h: 95 },
            reason: "Give dialogue more room",
          },
        ],
      })),
    };
  };
  const done = async (batchId: string) => {
    for (let index = 0; index < 200; index++) {
      const response = await f.call("carrot_get_format_batch", { batchId });
      expect(response.result.isError).toBe(false);
      if (response.result.structuredContent.status !== "running")
        return response.result.structuredContent;
      await delay(5);
    }
    throw new Error("Format HTTP batch did not settle");
  };
  return { ...f, request, done };
}
it("uses real authorization, handoff, atomic format storage and exact optional-state recovery", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const saved = await f.library.openChapter("chapter");
    const search = await f.call(
      "carrot_search_chapter_text",
      {
        chapterId: "chapter",
        mode: "browse",
        format: {
          conditions: [{ field: "fontSizePx", operator: "gt", value: 1 }],
        },
      },
      f.read,
    );
    expect(search.result.isError).toBe(false);
    expect(search.result.structuredContent.total).toBe(4);
    const input = await f.request();
    expect(
      (await f.call("carrot_preview_format_batch", input, f.read)).error,
    ).toBeDefined();
    const preview = await f.call("carrot_preview_format_batch", input);
    expect(preview.result.isError).toBe(false);
    const batchId = preview.result.structuredContent.batchId;
    expect(await f.snapshot()).toEqual(before);
    expect(
      (await f.call("carrot_get_format_batch", { batchId }, f.other)).result
        .isError,
    ).toBe(true);
    expect(
      (await f.call("carrot_get_translation_batch", { batchId })).result
        .isError,
    ).toBe(true);
    const apply = { batchId, requestId: randomUUID() };
    expect(
      (await f.call("carrot_apply_format_batch", apply)).result
        .structuredContent.status,
    ).toBe("accepted");
    expect((await f.done(batchId)).status).toBe("completed");
    const applied = await f.library.openChapter("chapter");
    for (const [index, page] of applied.pages.entries()) {
      expect(page.blocks[0].fontSizePx).toBe(34);
      expect(page.blocks[0].fontSizeIntent).toBe("manual");
      expect(page.blocks[0].sourceText).toBe(
        saved.pages[index].blocks[0].sourceText,
      );
      expect(page.blocks[0].translatedText).toBe(
        saved.pages[index].blocks[0].translatedText,
      );
      expect(page.blocks[0].bbox).toEqual(saved.pages[index].blocks[0].bbox);
      expect(page.blocks[1]).toEqual(saved.pages[index].blocks[1]);
    }
    for (const direction of ["undo", "redo", "undo"]) {
      await f.call(`carrot_${direction}_format_batch`, {
        batchId,
        requestId: randomUUID(),
      });
      expect((await f.done(batchId)).status).toBe("completed");
      const actual = await f.library.openChapter("chapter");
      expect(actual.pages.map((page) => page.blocks)).toEqual(
        (direction === "redo" ? applied : saved).pages.map(
          (page) => page.blocks,
        ),
      );
    }
    expect(
      (await f.call("carrot_apply_format_batch", apply)).result
        .structuredContent.historical,
    ).toBe(true);
    const restored = await f.library.openChapter("chapter");
    expect(restored.pages.map((page) => page.blocks)).toEqual(
      saved.pages.map((page) => page.blocks),
    );
    expect(restored.pages.map((page) => page.blockOrder)).toEqual(
      saved.pages.map((page) => page.blockOrder),
    );
    expect((await f.snapshot()).original).toBe(before.original);
    expect(JSON.stringify(preview)).not.toMatch(
      /imagePath|dataUrl|resource_link/,
    );
  } finally {
    await f.close();
  }
});
it("retains partial progress, rejects later user edits on undo and rejects text payloads", async () => {
  const f = await fixture();
  try {
    const input = await f.request();
    const invalid = structuredClone(input);
    Object.assign(invalid.pages[0].edits[0].fields, {
      translatedText: "not allowed",
    });
    const rejected = await f.call("carrot_preview_format_batch", invalid);
    expect(rejected.error).toBeDefined();
    const plan = (await f.call("carrot_preview_format_batch", input)).result
      .structuredContent;
    const page = (await f.library.openChapter("chapter")).pages[1];
    await f.call("carrot_update_translations", {
      chapterId: "chapter",
      pageId: page.id,
      revision: createPageRevision(page),
      edits: [{ blockId: "b", translatedText: "keep user wording" }],
    });
    await f.call("carrot_apply_format_batch", {
      batchId: plan.batchId,
      requestId: randomUUID(),
    });
    const partial = await f.done(plan.batchId);
    expect(partial.status).toBe("partial");
    expect(
      partial.pages.map((item: { result: string }) => item.result),
    ).toEqual(["saved", "failed"]);
    await f.call("carrot_undo_format_batch", {
      batchId: plan.batchId,
      requestId: randomUUID(),
    });
    expect((await f.done(plan.batchId)).status).toBe("completed");
    expect(
      (await f.library.openChapter("chapter")).pages[1].blocks[1]
        .translatedText,
    ).toBe("keep user wording");
  } finally {
    await f.close();
  }
});
it("denies changed-context forward writes and cancellation of an older action", async () => {
  const f = await fixture();
  try {
    const input = await f.request();
    const plan = (await f.call("carrot_preview_format_batch", input)).result
      .structuredContent;
    const saved = await f.library.readWorkContextForEdit("chapter");
    await f.library.saveWorkStyleGuide({
      ...saved.styleGuide,
      rules: { ...saved.styleGuide.rules, honorifics: "drop" },
    });
    const before = await f.snapshot();
    await f.call("carrot_apply_format_batch", {
      batchId: plan.batchId,
      requestId: randomUUID(),
    });
    const done = await f.done(plan.batchId);
    expect(done.status).toBe("failed");
    expect(done.pages[0].errorCode).toBe("revision_conflict");
    expect(await f.snapshot()).toEqual(before);
    expect(
      (
        await f.call("carrot_cancel_format_batch", {
          batchId: plan.batchId,
          requestId: randomUUID(),
        })
      ).result.isError,
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it("rechecks chapter membership inside the page lease before committing format snapshots", async () => {
  const { mcpBatchMembership } =
    await import("../src/main/application/mcpPageBatchPolicy");
  type Editor =
    import("../src/main/application/mcpPageEditService").McpPageEditService;
  let commit: Editor["commitFormatBatch"] | undefined;
  const f = await structureHttpFixture((service) => {
    commit = service.commitFormatBatch.bind(service);
    return [];
  });
  try {
    const chapter = await f.library.openChapter("chapter");
    const membership = mcpBatchMembership(chapter);
    const page = chapter.pages[0];
    const changed = JSON.parse(await readFile(f.chapterPath, "utf8"));
    changed.pages.push({
      ...structuredClone(changed.pages[0]),
      id: "later-page",
    });
    changed.pageOrder = changed.pages.map((item: { id: string }) => item.id);
    await writeFile(f.chapterPath, JSON.stringify(changed));
    const before = await f.snapshot();
    let committed = false;
    if (!commit) throw new Error("Fixture did not provide the page editor");
    await expect(
      commit(
        {
          chapterId: "chapter",
          pageId: page.id,
          revision: createPageRevision(page),
          blocks: [{ ...page.blocks[0], bold: true }],
        },
        membership,
        () => {},
        () => {
          committed = true;
        },
        (run) => run(),
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(committed).toBe(false);
    expect(f.notifySaved).not.toHaveBeenCalled();
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.close();
  }
});
