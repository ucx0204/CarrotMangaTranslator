import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pageDeletionFixture } from "./mcpPageDeletion.fixture";

it("deletes exactly one page with native memory reconciliation and restores all original bytes through restarted Undo/Redo", async () => {
  const f = await pageDeletionFixture();
  try {
    const review = await f.previewPage();
    expect(review).toMatchObject({
      pageId: f.selected.id,
      pageCount: 2,
      remainingPages: 1,
      memoryChanged: true,
      memoryRowsBefore: 4,
      memoryRowsAfter: 1,
    });
    expect(JSON.stringify(review)).not.toMatch(
      /PRIVATE|imagePath|original\.bin|story-memory/,
    );
    await f.assertPageOriginal();
    const keptBytes = await readFile(f.sibling.imagePath);
    const input = await f.commandPage();
    const saved = await f.applyPage(input);
    expect(saved.status).toBe("saved");
    await expect(lstat(f.selected.imagePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(f.removedRun)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.sibling.imagePath)).toEqual(keptBytes);
    expect(await readFile(join(f.siblingRun, "kept.txt"), "utf8")).toBe(
      "Sibling run data",
    );
    expect((await f.library.openChapter("chapter")).pageOrder).toEqual([
      f.sibling.id,
    ]);
    expect(JSON.parse(await readFile(f.memoryPath, "utf8")).pages).toEqual([
      { ...f.memory.pages[2], pageName: f.sibling.name, pageIndex: 0 },
    ]);
    await expect(f.genericDiscard(saved.id)).rejects.toThrow(/restoration/);
    await expect(
      f.call("carrot_discard_page_deletion", { id: saved.id, confirm: true }),
    ).rejects.toThrow(/Restore/);
    await f.restart();
    expect(await f.call("carrot_list_page_deletions", {})).toMatchObject({
      total: 1,
      items: [{ id: saved.id, pageCount: 1 }],
    });
    expect((await f.inspectPage(saved.id)).canUndo).toBe(true);
    const undo = await f.recoverPage(saved.id, "undo");
    await f.assertPageOriginal();
    expect(await f.call("carrot_undo_page_deletion", undo.input)).toMatchObject(
      { historical: true },
    );
    expect((await f.applyPage(input)).historical).toBe(true);
    await f.assertPageOriginal();
    await f.restart();
    await f.recoverPage(saved.id, "redo");
    expect((await f.library.openChapter("chapter")).pages).toHaveLength(1);
    await f.recoverPage(saved.id, "undo");
    await f.assertPageOriginal();
    await f.call("carrot_discard_page_deletion", {
      id: saved.id,
      confirm: true,
    });
    await f.assertPageOriginal();
    expect(await f.call("carrot_list_page_deletions", {})).toMatchObject({
      total: 0,
    });
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});

it("round-trips a page with no memory file and never creates an empty one during deletion or recovery", async () => {
  const f = await pageDeletionFixture(true, false);
  try {
    expect((await f.previewPage()).memoryChanged).toBe(false);
    const saved = await f.applyPage(await f.commandPage());
    await expect(readFile(f.memoryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await f.restart();
    await f.recoverPage(saved.id, "undo");
    await f.assertPageOriginal();
    await f.recoverPage(saved.id, "redo");
    await expect(readFile(f.memoryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await f.close();
  }
});
