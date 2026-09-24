import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { libraryOrganizationFixture } from "./mcpLibraryOrganization.fixture";
import type { McpLibraryOrganizationIntent } from "../src/shared/mcpLibraryOrganization";

it.each(["rename-work", "rename-chapter", "reorder-chapters"] as const)(
  "reviews and restores %s through native publication after reconstruction without changing pages",
  async (kind) => {
    const f = await libraryOrganizationFixture();
    try {
      const imported = await f.importCommand(await f.prepare());
      imported.target = await f.target("work");
      const added = await f.create(imported);
      const before = await f.library.openChapter("chapter");
      const original = await readFile(before.pages[0].imagePath);
      const workPath = join(f.env.libraryDir, "works", "work", "work.json");
      const originalWork = JSON.parse(await readFile(workPath, "utf8"));
      const intent: McpLibraryOrganizationIntent =
        kind === "reorder-chapters"
          ? {
              kind,
              workId: "work",
              chapterIds: [added.chapterIds[0], "chapter"],
            }
          : kind === "rename-chapter"
            ? {
                kind,
                workId: "work",
                chapterId: "chapter",
                title: "  새 이름 日本語 😀  ",
              }
            : { kind, workId: "work", title: "  새 이름 日本語 😀  " };
      const catalogBefore = await f.storage.index();
      const input = await f.command(intent);
      expect(await f.storage.index()).toEqual(catalogBefore);
      expect(JSON.parse(await readFile(workPath, "utf8"))).toEqual(
        originalWork,
      );
      const saved = await f.apply(input);
      expect(saved).toMatchObject({
        status: "saved",
        historical: false,
        direction: "apply",
      });
      expect((await f.library.openChapter("chapter")).pages).toEqual(
        before.pages,
      );
      const record = await f.storage.record(saved.id);
      expect(JSON.stringify(record)).not.toMatch(
        /sourceText|imagePath|selectionSha256|blocks|dataUrl/,
      );
      await f.restart();
      expect(await f.inspectChange(saved.id)).toMatchObject({
        canUndo: true,
        canRedo: false,
      });
      const undo = await f.recover(saved.id, "undo");
      expect((await f.inspectChange(saved.id)).snapshot).toBe(input.snapshot);
      expect(await f.apply(input)).toMatchObject({ historical: true });
      expect(
        await f.call("carrot_undo_library_change", undo.input),
      ).toMatchObject({ historical: true });
      expect((await f.inspectChange(saved.id)).canRedo).toBe(true);
      await f.recover(saved.id, "redo");
      expect((await f.inspectChange(saved.id)).snapshot).toBe(saved.snapshot);
      await f.recover(saved.id, "undo");
      expect(await f.library.openChapter("chapter")).toEqual(before);
      expect(JSON.parse(await readFile(workPath, "utf8"))).toEqual(
        originalWork,
      );
      expect(await readFile(before.pages[0].imagePath)).toEqual(original);
      await f.discardChange(saved.id);
      await expect(f.inspectChange(saved.id)).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await f.library.openChapter("chapter")).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

it("records no-op requests without touching metadata timestamps or offering meaningless recovery", async () => {
  const f = await libraryOrganizationFixture();
  try {
    const before = await f.library.listLibrary();
    const input = await f.command({
      kind: "rename-work",
      workId: "work",
      title: before.works[0].title,
    });
    const saved = await f.apply(input);
    expect(saved).toMatchObject({
      status: "unchanged",
      snapshot: input.snapshot,
    });
    expect(await f.library.listLibrary()).toEqual(before);
    expect(await f.inspectChange(saved.id)).toMatchObject({
      changed: false,
      canUndo: false,
      canRedo: false,
    });
    await expect(f.recover(saved.id, "undo")).rejects.toMatchObject({
      code: "invalid_edit",
    });
    await f.restart();
    expect(await f.apply(input)).toMatchObject({
      status: "already_applied",
      historical: true,
    });
  } finally {
    await f.close();
  }
});
