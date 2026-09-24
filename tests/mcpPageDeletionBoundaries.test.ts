import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { pageDeletionFixture } from "./mcpPageDeletion.fixture";

it("requires explicit scoped confirmation and a closed editor, rejects stale review and isolates owners and request IDs", async () => {
  const f = await pageDeletionFixture();
  try {
    const input = await f.commandPage();
    await expect(
      f.call("carrot_delete_page", { ...input, confirm: true }),
    ).rejects.toThrow();
    await expect(
      f.call("carrot_delete_page", { ...input, path: "C:/private" }),
    ).rejects.toThrow();
    await expect(
      f.applyPage({ ...input, snapshot: "0".repeat(16) }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      f.previewPage({ ...f.pageTarget, pageId: "missing" }),
    ).rejects.toMatchObject({ code: "not_found" });
    f.editorOpen(f.pageTarget.chapterId);
    await expect(f.applyPage(input)).rejects.toMatchObject({
      code: "editor_busy",
    });
    f.editorOpen(null);
    await f.assertPageOriginal();
    const saved = await f.applyPage(input);
    await expect(
      f.call(
        "carrot_get_page_deletion",
        { id: saved.id },
        f.auth("another-owner"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await f.call("carrot_list_page_deletions", {}, f.auth("another-owner")),
    ).toMatchObject({ total: 0 });
    await expect(
      f.applyPage({ ...input, pageId: f.sibling.id }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    const view = await f.inspectPage(saved.id);
    await expect(
      f.call("carrot_undo_page_deletion", {
        id: saved.id,
        snapshot: view.snapshot,
        requestId: input.requestId,
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    const undo = await f.recoverPage(saved.id, "undo");
    await expect(
      f.call("carrot_redo_page_deletion", undo.input),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    await f.assertPageOriginal();
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});

it("refuses deletion when the trusted editor probe is unavailable", async () => {
  const f = await pageDeletionFixture(false);
  try {
    await expect(f.applyPage(await f.commandPage())).rejects.toMatchObject({
      code: "editor_busy",
    });
    await f.assertPageOriginal();
  } finally {
    await f.close();
  }
});

it.each(["memory", "sibling", "work", "occupied"] as const)(
  "preserves later %s data instead of forcing Undo",
  async (kind) => {
    const f = await pageDeletionFixture();
    try {
      const saved = await f.applyPage(await f.commandPage());
      const path =
        kind === "memory"
          ? f.memoryPath
          : kind === "sibling"
            ? f.sibling.imagePath
            : kind === "work"
              ? f.workPath
              : f.selected.imagePath;
      let value = Buffer.from("Later user data");
      if (kind === "memory" || kind === "work") {
        const current = JSON.parse(await readFile(path, "utf8"));
        if (kind === "memory")
          current.pages[0].summary = "Later manual summary";
        else current.title = "Later work title";
        value = Buffer.from(JSON.stringify(current));
      }
      await writeFile(path, value);
      const view = await f.inspectPage(saved.id);
      expect(view.canUndo).toBe(false);
      await expect(
        f.call("carrot_undo_page_deletion", {
          id: saved.id,
          snapshot: saved.snapshot,
          requestId: randomUUID(),
          confirm: true,
        }),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      expect(await readFile(path)).toEqual(value);
      expect(
        (await f.library.openChapter(f.pageTarget.chapterId)).pages,
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

it("does not confuse an originally absent memory with a newly created empty file", async () => {
  const f = await pageDeletionFixture(true, false);
  try {
    const saved = await f.applyPage(await f.commandPage());
    const value = JSON.stringify({ ...f.memory, pages: [] });
    await writeFile(f.memoryPath, value);
    expect((await f.inspectPage(saved.id)).canUndo).toBe(false);
    await expect(f.recoverPage(saved.id, "undo")).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(await readFile(f.memoryPath, "utf8")).toBe(value);
  } finally {
    await f.close();
  }
});
