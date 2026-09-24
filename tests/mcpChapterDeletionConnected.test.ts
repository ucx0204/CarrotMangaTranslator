import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chapterDeletionFixture } from "./mcpChapterDeletion.fixture";

it("removes and restores exact chapter bytes after reconstruction without changing external sources", async () => {
  const f = await chapterDeletionFixture();
  try {
    const originals = await Promise.all(
      f.originals.map((path) => readFile(path)),
    );
    const review = await f.preview();
    expect(review).toMatchObject({
      pageCount: f.source.chapter.pages.length,
      fileCount: f.tree.files.length,
      directoryCount: f.tree.directories.length,
    });
    expect(JSON.stringify(review)).not.toMatch(
      /imagePath|sourceText|note\.txt|Private original/,
    );
    expect((await f.storage.index()).entries).toEqual([]);
    await f.assertOriginal();
    const input = await f.command();
    const saved = await f.apply(input);
    expect(saved.status).toBe("saved");
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.library.listLibrary()).works[0].chapters).toEqual([]);
    expect(f.notify).toHaveBeenCalledOnce();
    const index = await f.storage.index();
    expect(index.entries).toMatchObject([
      {
        id: saved.id,
        kind: "chapter-deletion",
        pageCount: f.source.chapter.pages.length,
      },
    ]);
    await expect(f.genericDiscard(saved.id)).rejects.toThrow(
      /discard_chapter_deletion/,
    );
    await expect(
      f.call("carrot_discard_chapter_deletion", {
        id: saved.id,
        confirm: true,
      }),
    ).rejects.toThrow(/Restore the chapter/);
    await f.restart();
    expect(await f.apply(input)).toMatchObject({
      historical: true,
      id: saved.id,
    });
    expect(await f.call("carrot_list_chapter_deletions", {})).toMatchObject({
      total: 1,
    });
    expect(await f.inspect(saved.id)).toMatchObject({
      canUndo: true,
      canRedo: false,
      deleted: true,
    });
    const undo = await f.recover(saved.id, "undo");
    await f.assertOriginal();
    const count = f.notify.mock.calls.length;
    expect(
      await f.call("carrot_undo_chapter_deletion", undo.input),
    ).toMatchObject({ historical: true });
    expect(await f.apply(input)).toMatchObject({ historical: true });
    expect(f.notify).toHaveBeenCalledTimes(count);
    await f.assertOriginal();
    await f.restart();
    await f.recover(saved.id, "redo");
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await f.recover(saved.id, "undo");
    await f.assertOriginal();
    expect(
      await f.call("carrot_discard_chapter_deletion", {
        id: saved.id,
        confirm: true,
      }),
    ).toMatchObject({ status: "discarded", chapterChanges: 0 });
    await expect(f.inspect(saved.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await f.assertOriginal();
    expect(
      await Promise.all(f.originals.map((path) => readFile(path))),
    ).toEqual(originals);
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});

it("requires a trusted closed editor, including for a clean open chapter", async () => {
  const f = await chapterDeletionFixture();
  try {
    const input = await f.command();
    f.editorOpen("chapter");
    await expect(f.apply(input)).rejects.toMatchObject({ code: "editor_busy" });
    await f.assertOriginal();
    expect((await f.storage.index()).entries).toEqual([]);
    f.editorOpen("different-chapter");
    const saved = await f.apply(input);
    f.editorOpen("chapter");
    await expect(f.recover(saved.id, "undo")).rejects.toMatchObject({
      code: "editor_busy",
    });
    f.editorOpen(null);
    await f.recover(saved.id, "undo");
    await f.assertOriginal();
  } finally {
    await f.close();
  }
});

it("fails closed when the native closed-editor probe is absent", async () => {
  const missing = await chapterDeletionFixture(false);
  try {
    await expect(missing.apply(await missing.command())).rejects.toThrow(
      /probe is unavailable/,
    );
    await missing.assertOriginal();
  } finally {
    await missing.close();
  }
});

it("refuses newer chapter bytes before deletion and newer work metadata before exact restore", async () => {
  const f = await chapterDeletionFixture();
  try {
    const input = await f.command();
    const path = join(f.directory, "runs", "preserved", "note.txt");
    await writeFile(path, "Later saved content");
    await expect(f.apply(input)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(await readFile(path, "utf8")).toBe("Later saved content");
    const saved = await f.apply(await f.command());
    await f.library.renameWork("work", "Later work title");
    expect(await f.inspect(saved.id)).toMatchObject({
      canUndo: false,
      canRedo: false,
    });
    await expect(f.recover(saved.id, "undo")).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect((await f.library.listLibrary()).works[0].title).toBe(
      "Later work title",
    );
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});

it("keeps a committed deletion and its receipt when only renderer notification fails", async () => {
  const f = await chapterDeletionFixture();
  try {
    f.notify.mockImplementation(() => {
      throw new Error("Fixture window notification failed");
    });
    const input = await f.command();
    const saved = await f.apply(input);
    expect(saved.warnings).toContain("notification_failed_after_commit");
    expect((await f.inspect(saved.id)).canUndo).toBe(true);
    expect(await f.apply(input)).toMatchObject({ historical: true });
    f.notify.mockReset();
    await f.recover(saved.id, "undo");
    await f.assertOriginal();
  } finally {
    await f.close();
  }
});
