import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { memoryRefreshAppFixture } from "./mcpMemoryRefreshApp.fixture";

it("previews without writes and restores a newly created memory file to absence across restart and replay", async () => {
  const f = await memoryRefreshAppFixture();
  try {
    const file = join(dirname(f.chapterPath), "story-memory.json");
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const before = await f.graph();
    const chapterBytes = await readFile(f.chapterPath);
    const otherBytes = await readFile(f.secondPath);
    const request = await f.memoryInput();
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.storage.index()).entries).toEqual([]);
    const receipt = await f.refresh(request);
    expect(receipt).toMatchObject({
      status: "saved",
      changes: { guideChanged: false, pages: 0, blocks: 0, memories: 1 },
    });
    const after = await f.library.getChapterStoryMemory("chapter");
    expect(after.pages[0]).toMatchObject({
      summary: "Reviewed current page text",
      textEvidence: { version: 1, method: "reviewed-page-text" },
    });
    expect((await f.status()).counts.current).toBe(1);
    expect(await readFile(f.chapterPath)).toEqual(chapterBytes);
    expect(await readFile(f.secondPath)).toEqual(otherBytes);
    expect((await f.graph()).styleGuide).toEqual(before.styleGuide);
    expect((await f.storage.index()).entries[0].operation).toBe(
      "carrot_apply_memory_refresh",
    );
    await f.restart();
    await f.recover(receipt.id, "undo");
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.refresh(request)).status).toBe("already_applied");
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await f.recover(receipt.id, "redo");
    expect(await f.library.getChapterStoryMemory("chapter")).toEqual(after);
    await f.recover(receipt.id, "undo");
    await f.invoke("carrot_discard_retained", {
      id: receipt.id,
      confirm: true,
    });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.chapterPath)).toEqual(chapterBytes);
  } finally {
    await f.close();
  }
});

it("preserves existing manual visual summaries and unrelated rows, and makes an identical new refresh a no-op", async () => {
  const f = await memoryRefreshAppFixture();
  try {
    const graph = await f.graph();
    const page = graph.chapters[0].chapter.pages[0];
    const memory = await f.library.getChapterStoryMemory("chapter");
    memory.pages = [
      {
        pageId: page.id,
        pageName: page.name,
        pageIndex: 0,
        sourceDigest: "Old source",
        translatedDigest: "Old target",
        summary: "Old summary",
        visualSummary: "Manual drawing observation",
        visualSummarySource: "manual",
        updatedAt: "old",
      },
      { ...graph.chapters[1].storyMemory.pages[0] },
    ];
    await f.library.saveChapterStoryMemory(memory);
    const before = await f.library.getChapterStoryMemory("chapter");
    await expect(
      f.memoryInput({ replaceExistingSummary: false }),
    ).rejects.toThrow("replaceExistingSummary");
    const receipt = await f.refresh();
    const after = await f.library.getChapterStoryMemory("chapter");
    expect(after.pages[0]).toMatchObject({
      summary: "Reviewed current page text",
      visualSummary: "Manual drawing observation",
      visualSummarySource: "manual",
    });
    expect(after.pages[1]).toEqual(before.pages[1]);
    const unchanged = await f.refresh();
    expect(unchanged.status).toBe("unchanged");
    expect(await f.library.getChapterStoryMemory("chapter")).toEqual(after);
    expect((await f.inspect(unchanged.id)).canUndo).toBe(false);
    await f.restart();
    await f.recover(receipt.id, "undo");
    expect(await f.library.getChapterStoryMemory("chapter")).toEqual(before);
  } finally {
    await f.close();
  }
});

it("rejects changed saved text and protects subsequent manual edits from recovery", async () => {
  const f = await memoryRefreshAppFixture();
  try {
    const request = await f.memoryInput();
    const changed = JSON.parse(await readFile(f.secondPath, "utf8"));
    changed.pages[0].blocks[0].sourceText =
      "Changed other selected-work chapter";
    await writeFile(f.secondPath, JSON.stringify(changed));
    await expect(f.refresh(request)).rejects.toThrow("changed before refresh");
    expect((await f.storage.index()).entries).toEqual([]);
    const receipt = await f.refresh();
    const memory = await f.library.getChapterStoryMemory("chapter");
    memory.pages[0].summary = "Later manual edit";
    await f.library.saveChapterStoryMemory(memory);
    expect((await f.status()).counts.stale).toBe(1);
    await expect(f.recover(receipt.id, "undo")).rejects.toThrow(
      "changed after",
    );
    expect(
      (await f.library.getChapterStoryMemory("chapter")).pages[0].summary,
    ).toBe("Later manual edit");
    await expect(
      f.invoke(
        "carrot_get_context_migration",
        { id: receipt.id },
        f.auth("other-owner"),
      ),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("does not overwrite a recreated empty memory file when redoing a previously absent file", async () => {
  const f = await memoryRefreshAppFixture();
  try {
    const receipt = await f.refresh();
    await f.recover(receipt.id, "undo");
    const memory = await f.library.getChapterStoryMemory("chapter");
    await f.library.saveChapterStoryMemory(memory);
    const file = join(dirname(f.chapterPath), "story-memory.json");
    const bytes = await readFile(file);
    expect((await f.inspect(receipt.id)).canRedo).toBe(false);
    await expect(f.recover(receipt.id, "redo")).rejects.toThrow(
      "file presence changed",
    );
    expect(await readFile(file)).toEqual(bytes);
  } finally {
    await f.close();
  }
});

it("keeps pre-presence context recovery records usable after reconstruction", async () => {
  const f = await memoryRefreshAppFixture();
  const { RetainedContextMigrationSchema } =
    await import("../src/shared/mcpContextMigrationState");
  const { withLibraryMutation } = await import("../src/main/library/lock");
  const { runLibraryTransaction } =
    await import("../src/main/libraryStore/libraryTransaction");
  try {
    const before = await f.graph();
    const applied = await f.apply();
    const record = RetainedContextMigrationSchema.parse(
      await f.storage.record(applied.id),
    );
    for (const memory of record.delta.memories) delete memory.beforePresent;
    await withLibraryMutation(() =>
      runLibraryTransaction("test-legacy-memory-receipt", (transaction) =>
        f.storage.stageRecord(transaction, record.id, record),
      ),
    );
    await f.restart();
    expect((await f.inspect(applied.id)).canUndo).toBe(true);
    await f.recover(applied.id, "undo");
    const after = await f.graph();
    expect(after.styleGuide).toEqual(before.styleGuide);
    expect(after.chapters[1].storyMemory).toEqual(
      before.chapters[1].storyMemory,
    );
  } finally {
    await f.close();
  }
});
