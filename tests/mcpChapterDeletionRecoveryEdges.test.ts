import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chapterDeletionFixture } from "./mcpChapterDeletion.fixture";
import { ChapterDeletionRecordSchema } from "../src/main/application/mcpChapterDeletionState";

it.each(["occupied", "missing-work"] as const)(
  "does not overwrite or recreate a %s recovery target",
  async (mode) => {
    const f = await chapterDeletionFixture();
    try {
      const saved = await f.apply(await f.command());
      if (mode === "occupied") {
        await mkdir(f.directory);
        await writeFile(
          join(f.directory, "new-user-file.txt"),
          "Later unrelated data",
        );
      } else await f.library.deleteWork("work");
      await expect(f.inspect(saved.id)).rejects.toThrow();
      await expect(
        f.call("carrot_undo_chapter_deletion", {
          id: saved.id,
          snapshot: saved.snapshot,
          requestId: crypto.randomUUID(),
          confirm: true,
        }),
      ).rejects.toThrow();
      if (mode === "occupied")
        expect(
          await readFile(join(f.directory, "new-user-file.txt"), "utf8"),
        ).toBe("Later unrelated data");
      else expect((await f.library.listLibrary()).works).toEqual([]);
      expect((await f.storage.index()).entries).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

it("rejects corrupt retained bytes in both inspection and restore without publishing a partial directory", async () => {
  const f = await chapterDeletionFixture();
  try {
    const saved = await f.apply(await f.command());
    const record = ChapterDeletionRecordSchema.parse(
      await f.storage.record(saved.id),
    );
    const hash = record.parts.flat()[0];
    const path = await f.storage.path(saved.id, hash);
    const original = await readFile(path);
    await writeFile(
      path,
      JSON.stringify(
        await f.codec.seal({
          chunk: Buffer.from("Different bytes").toString("base64"),
        }),
      ),
    );
    await expect(f.inspect(saved.id)).rejects.toThrow(/inconsistent/);
    await expect(
      f.call("carrot_undo_chapter_deletion", {
        id: saved.id,
        snapshot: saved.snapshot,
        requestId: crypto.randomUUID(),
        confirm: true,
      }),
    ).rejects.toThrow(/inconsistent/);
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path, original);
    await f.recover(saved.id, "undo");
    await f.assertOriginal();
  } finally {
    await f.close();
  }
});

it("preserves historical request identity and reports expiry without resurrecting the deleted chapter", async () => {
  const f = await chapterDeletionFixture();
  try {
    const input = await f.command();
    const saved = await f.apply(input);
    await expect(
      f.apply({ ...input, snapshot: "0".repeat(16) }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    await expect(f.preview()).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.call("carrot_redo_chapter_deletion", {
        id: saved.id,
        snapshot: saved.snapshot,
        requestId: crypto.randomUUID(),
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    f.clock(saved.expiresAt);
    await expect(f.inspect(saved.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await f.call("carrot_list_chapter_deletions", {})).toMatchObject({
      items: [{ id: saved.id, available: false }],
    });
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});

it("supports zero-page chapters without treating their non-page files as disposable", async () => {
  const f = await chapterDeletionFixture();
  try {
    const path = join(f.directory, "chapter.json");
    const chapter = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({ ...chapter, pages: [], pageOrder: [] }),
    );
    const expected = await f.files.captureChapterDeletionTree(
      f.directory,
      () => {},
    );
    expect((await f.preview()).pageCount).toBe(0);
    const saved = await f.apply(await f.command());
    expect((await f.inspect(saved.id)).pageCount).toBe(0);
    await f.recover(saved.id, "undo");
    expect(
      await f.files.captureChapterDeletionTree(f.directory, () => {}),
    ).toEqual(expected);
  } finally {
    await f.close();
  }
});
