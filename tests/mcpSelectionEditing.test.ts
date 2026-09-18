import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { selectionEditingFixture } from "./mcpSelectionEditing.fixture";
import { resolvePageBlockOrder } from "../src/shared/blockReadingOrder";

it.each(["source", "translation"] as const)("applies only reviewed %s text and exactly restores native blocks without another model call", async (kind) => {
  const f = await selectionEditingFixture();
  try {
    const before = await f.snapshot();
    const { input } = await f.prepare(kind);
    const disk = await readFile(f.chapterPath);
    const plan = await f.preview(input);
    const inspected = await f.inspect(plan.batchId);
    expect(inspected.totalChanges).toBe(2);
    expect(await readFile(f.chapterPath)).toEqual(disk);
    expect((await f.preview(input)).batchId).toBe(plan.batchId);
    expect((await f.action(plan.batchId, "apply")).result.status).toBe("completed");
    const after = await f.snapshot();
    for (const [index, page] of after.pages.entries()) {
      const field = kind === "source" ? "sourceText" : "translatedText";
      expect(page.blocks[0][field]).not.toBe(before.pages[index].blocks[0][field]);
      expect({ ...page.blocks[0], [field]: before.pages[index].blocks[0][field] }).toEqual(before.pages[index].blocks[0]);
      expect(page.blocks.slice(1)).toEqual(before.pages[index].blocks.slice(1));
      expect(page.blockOrder).toEqual(before.pages[index].blockOrder);
      expect(await readFile(page.imagePath)).toEqual(f.bytes);
    }
    expect((await f.action(plan.batchId, "undo")).result.status).toBe("completed");
    const restored = await f.snapshot();
    expect(restored.pages.map((page) => page.blocks)).toEqual(before.pages.map((page) => page.blocks));
    expect((await f.action(plan.batchId, "redo")).result.status).toBe("completed");
    expect((await f.snapshot()).pages.map((page) => page.blocks)).toEqual(after.pages.map((page) => page.blocks));
    expect(f.request).toHaveBeenCalledTimes(kind === "translation" ? 2 : 0);
    expect(f.collect).toHaveBeenCalledTimes(kind === "source" ? 4 : 0);
    expect(f.app.jobs.all).toEqual([]);
  } finally { await f.close(); }
});

it("appends reviewed OCR discoveries at the front and undo removes only owned blocks with absent order restored", async () => {
  const f = await selectionEditingFixture();
  try {
    await f.mutateStored((chapter) => { for (const page of chapter.pages) delete page.blockOrder; });
    const before = await f.snapshot();
    const { input } = await f.prepare("append");
    const plan = await f.preview(input);
    const view = await f.inspect(plan.batchId);
    expect(view.changes.every((change) => change.before === null)).toBe(true);
    expect(view.changes[0].overlapBlockIds).toContain("a");
    expect((await f.action(plan.batchId, "apply")).result.status).toBe("completed");
    const after = await f.snapshot();
    for (const [index, page] of after.pages.entries()) {
      expect(page.blocks).toHaveLength(before.pages[index].blocks.length + 1);
      expect(page.blocks.slice(0, -1)).toEqual(before.pages[index].blocks);
      expect(resolvePageBlockOrder(page)[0]).toBe(view.changes[index].blockId);
      expect(page.blocks.at(-1)?.translatedText).toBe("");
      expect(page.blocks.at(-1)?.sourceText).toBe("再読\n한글 🥕");
    }
    expect((await f.action(plan.batchId, "undo")).result.status).toBe("completed");
    const restored = await f.snapshot();
    expect(restored.pages.map((page) => page.blocks)).toEqual(before.pages.map((page) => page.blocks));
    expect(restored.pages.every((page) => page.blockOrder === undefined)).toBe(true);
    expect((await f.action(plan.batchId, "redo")).result.status).toBe("completed");
    expect((await f.snapshot()).pages.map((page) => page.blocks)).toEqual(after.pages.map((page) => page.blocks));
    expect(f.collect).toHaveBeenCalledTimes(4);
  } finally { await f.close(); }
});

it("requires overlap approval and an existing reading-order anchor before saving discoveries", async () => {
  const f = await selectionEditingFixture();
  try {
    const { input } = await f.prepare("append", false);
    const edit = input.pages[0].edits[0];
    if (edit.kind !== "append") throw new Error("Unexpected fixture edit");
    const before = await readFile(f.chapterPath);
    edit.allowOverlap = false;
    await expect(f.preview(input)).rejects.toThrow(/overlap/i);
    edit.allowOverlap = true;
    edit.afterBlockId = "missing-anchor";
    await expect(f.preview(input)).rejects.toThrow(/anchor/i);
    edit.afterBlockId = "a";
    const plan = await f.preview(input);
    expect((await f.action(plan.batchId, "apply")).result.status).toBe("completed");
    const page = (await f.snapshot()).pages[0];
    expect(resolvePageBlockOrder(page).slice(0, 2)).toEqual(["a", (await f.inspect(plan.batchId)).changes[0].blockId]);
    expect(before.equals(await readFile(f.chapterPath))).toBe(false);
  } finally { await f.close(); }
});

it("clears references without deleting fields omitted from the request and restores optional absence", async () => {
  const f = await selectionEditingFixture();
  try {
    await f.mutateStored((chapter) => {
      for (const page of chapter.pages) {
        page.blocks[0].speakerId = "old-speaker";
        delete page.blocks[0].glossaryEntryIds;
      }
    });
    const before = await f.snapshot();
    const plan = await f.preview(await f.references());
    expect((await f.action(plan.batchId, "apply")).result.status).toBe("completed");
    const after = await f.snapshot();
    for (const [index, page] of after.pages.entries()) {
      expect(Object.hasOwn(page.blocks[0], "speakerId")).toBe(false);
      expect(page.blocks[0].glossaryEntryIds).toEqual([]);
      expect({ ...page.blocks[0], speakerId: "old-speaker", glossaryEntryIds: undefined }).toEqual({ ...before.pages[index].blocks[0], glossaryEntryIds: undefined });
    }
    expect((await f.action(plan.batchId, "undo")).result.status).toBe("completed");
    expect((await f.snapshot()).pages.map((page) => page.blocks)).toEqual(before.pages.map((page) => page.blocks));
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    const omitted = await f.preview(await f.references({ glossaryEntryIds: [] }));
    await f.action(omitted.batchId, "apply");
    expect((await f.snapshot()).pages[0].blocks[0].speakerId).toBe("old-speaker");
  } finally { await f.close(); }
});

it("does not let a repeated historical action reapply after undo or replace different preview input", async () => {
  const f = await selectionEditingFixture();
  try {
    const { input } = await f.prepare("translation");
    const plan = await f.preview(input);
    await expect(f.preview({ ...input, reason: "different" })).rejects.toThrow(/requestId/i);
    const actionId = randomUUID();
    await f.action(plan.batchId, "apply", actionId);
    await f.action(plan.batchId, "undo");
    const beforeReplay = await readFile(f.chapterPath);
    const repeated = await f.action(plan.batchId, "apply", actionId);
    expect(repeated.receipt).toMatchObject({ historical: true, status: "already_started" });
    expect(await readFile(f.chapterPath)).toEqual(beforeReplay);
    await expect(f.action(plan.batchId, "redo", actionId)).rejects.toThrow(/requestId/i);
  } finally { await f.close(); }
});
