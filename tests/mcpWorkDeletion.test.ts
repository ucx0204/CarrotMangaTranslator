import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workDeletionFixture } from "./mcpWorkDeletion.fixture";

it("reviews and deletes an entire work atomically, reconstructs exact Undo/Redo and never repeats historical deletion", async () => {
  const f = await workDeletionFixture();
  try {
    const other = await readFile(join(f.destinationRoot, "work.json"));
    const review = await f.previewWork();
    expect(review).toMatchObject({
      workId: "work",
      chapters: [{ chapterId: "chapter" }],
      pageCount: f.source.chapter.pages.length,
    });
    expect(JSON.stringify(review)).not.toMatch(
      /sourceText|imagePath|note\.txt|Private original|dataUrl/,
    );
    expect((await f.storage.index()).entries).toEqual([]);
    await f.assertWorkOriginal();
    const input = await f.commandWork();
    const saved = await f.applyWork(input);
    await expect(lstat(f.workDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(JSON.parse(await readFile(f.indexPath, "utf8"))).toEqual({
      workOrder: ["destination"],
    });
    await expect(f.genericDiscard(saved.id)).rejects.toThrow();
    await expect(
      f.call("carrot_discard_work_deletion", { id: saved.id, confirm: true }),
    ).rejects.toThrow(/Restore/);
    await f.restart();
    expect(await f.applyWork(input)).toMatchObject({
      id: saved.id,
      historical: true,
    });
    expect(await f.inspectWork(saved.id)).toMatchObject({
      deleted: true,
      canUndo: true,
      canRedo: false,
    });
    expect(await f.call("carrot_list_work_deletions", {})).toMatchObject({
      total: 1,
      items: [{ id: saved.id, kind: "work-deletion" }],
    });
    const undo = await f.recoverWork(saved.id, "undo");
    await f.assertWorkOriginal();
    expect(await f.call("carrot_undo_work_deletion", undo.input)).toMatchObject(
      { historical: true },
    );
    expect((await f.applyWork(input)).historical).toBe(true);
    await f.assertWorkOriginal();
    await f.restart();
    await f.recoverWork(saved.id, "redo");
    await expect(lstat(f.workDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await f.recoverWork(saved.id, "undo");
    await f.assertWorkOriginal();
    expect(
      await f.call("carrot_discard_work_deletion", {
        id: saved.id,
        confirm: true,
      }),
    ).toMatchObject({ status: "discarded", workChanges: 0 });
    await expect(f.inspectWork(saved.id)).rejects.toThrow();
    expect(await readFile(join(f.destinationRoot, "work.json"))).toEqual(other);
    await f.assertOriginal();
    expect(f.notify).toHaveBeenCalledTimes(4);
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});

it("retains all chapters, private context, manual memory and unreferenced files as exact bytes", async () => {
  const f = await workDeletionFixture();
  try {
    await f.applyMove(
      await f.commandMove({
        workId: "destination",
        chapterId: "dest-chapter",
        destinationWorkId: "work",
      }),
    );
    await writeFile(
      join(f.workDirectory, "style-guide.json"),
      "User context is retained verbatim; deletion does not rewrite it.",
    );
    await writeFile(
      join(f.directory, "story-memory.json"),
      "Manual memory need not be regenerated to delete or restore the work.",
    );
    const before = await f.captureWork();
    expect(
      (await f.previewWork()).chapters.map((chapter) => chapter.chapterId),
    ).toEqual(["chapter", "dest-chapter"]);
    const saved = await f.applyWork(await f.commandWork());
    await f.restart();
    await f.recoverWork(saved.id, "undo");
    expect(await f.captureWork()).toEqual(before);
    expect(f.assertClosed.mock.calls.map(([id]) => id)).toEqual(
      expect.arrayContaining(["chapter", "dest-chapter"]),
    );
  } finally {
    await f.close();
  }
});

it("supports an empty work without creating chapters or losing its original empty directories", async () => {
  const f = await workDeletionFixture();
  try {
    await f.library.deleteChapter("chapter");
    const before = await f.captureWork();
    expect(await f.previewWork()).toMatchObject({ chapters: [], pageCount: 0 });
    const saved = await f.applyWork(await f.commandWork());
    await f.restart();
    await f.recoverWork(saved.id, "undo");
    expect(await f.captureWork()).toEqual(before);
    await f.recoverWork(saved.id, "redo");
    await f.recoverWork(saved.id, "undo");
    expect(await f.captureWork()).toEqual(before);
  } finally {
    await f.close();
  }
});
