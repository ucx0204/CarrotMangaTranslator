import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workDeletionFixture } from "./mcpWorkDeletion.fixture";
import { McpWorkDeletionApplySchema } from "../src/shared/mcpWorkDeletion";

it("requires exact confirmation, current review and a closed chapter; read-only configuration exposes no mutations", async () => {
  const f = await workDeletionFixture();
  try {
    const input = await f.commandWork();
    for (const confirm of [
      true,
      false,
      "delete",
      "delete-chapter-with-seven-day-recovery",
    ])
      expect(
        McpWorkDeletionApplySchema.safeParse({ ...input, confirm }).success,
      ).toBe(false);
    for (const value of [
      { workId: "../work" },
      { workId: "work", path: "C:/private" },
      { workId: "missing" },
    ])
      await expect(
        f.call("carrot_preview_work_deletion", value),
      ).rejects.toThrow();
    f.editorOpen("chapter");
    await expect(f.applyWork(input)).rejects.toMatchObject({
      code: "editor_busy",
    });
    f.editorOpen(null);
    await f.library.renameWork("work", "Changed after review");
    await expect(f.applyWork(input)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect((await f.storage.index()).entries).toEqual([]);
    f.preferences.allowEditing = false;
    await f.restart();
    const tools = f
      .organization()
      .tools.filter(
        (tool) =>
          tool.name.includes("work_deletion") ||
          tool.name === "carrot_delete_work",
      );
    expect(tools).toHaveLength(3);
    expect(tools.every((tool) => tool.readOnly)).toBe(true);
  } finally {
    await f.close();
  }
});

it("refuses mutation when the trusted editor probe is absent", async () => {
  const f = await workDeletionFixture(false);
  try {
    await expect(f.applyWork(await f.commandWork())).rejects.toMatchObject({
      code: "editor_busy",
    });
    await f.assertWorkOriginal();
  } finally {
    await f.close();
  }
});

it("keeps ownership and request signatures isolated across restart", async () => {
  const f = await workDeletionFixture();
  try {
    const input = await f.commandWork();
    const saved = await f.applyWork(input);
    await f.restart();
    await expect(
      f.call("carrot_get_work_deletion", { id: saved.id }, f.auth("other")),
    ).rejects.toThrow();
    expect(
      await f.call("carrot_list_work_deletions", {}, f.auth("other")),
    ).toMatchObject({ total: 0 });
    await expect(
      f.applyWork({ ...input, workId: "destination" }),
    ).rejects.toThrow(/Request ID/);
    const undo = await f.recoverWork(saved.id, "undo");
    await expect(
      f.call("carrot_redo_work_deletion", undo.input),
    ).rejects.toThrow(/Request ID/);
    await f.assertWorkOriginal();
  } finally {
    await f.close();
  }
});

it.each(["occupied", "index-changed", "expired"] as const)(
  "preserves later data when %s prevents recovery",
  async (failure) => {
    const f = await workDeletionFixture();
    try {
      const saved = await f.applyWork(await f.commandWork());
      if (failure === "occupied") {
        await mkdir(f.workDirectory);
        await writeFile(
          join(f.workDirectory, "later.txt"),
          "Later user-owned file",
        );
      } else if (failure === "index-changed") {
        await writeFile(
          f.indexPath,
          JSON.stringify({ workOrder: ["destination", "later-work"] }),
        );
      } else f.clock(saved.expiresAt);
      const before = await readFile(f.indexPath);
      await expect(
        f.call("carrot_undo_work_deletion", {
          id: saved.id,
          snapshot: saved.snapshot,
          requestId: randomUUID(),
          confirm: true,
        }),
      ).rejects.toThrow();
      expect(await readFile(f.indexPath)).toEqual(before);
      if (failure === "occupied")
        expect(await readFile(join(f.workDirectory, "later.txt"), "utf8")).toBe(
          "Later user-owned file",
        );
      else
        await expect(lstat(f.workDirectory)).rejects.toMatchObject({
          code: "ENOENT",
        });
      if (failure === "expired")
        expect(await f.call("carrot_list_work_deletions", {})).toMatchObject({
          items: [{ available: false }],
        });
    } finally {
      await f.close();
    }
  },
);

it.each([
  "unlisted-directory",
  "duplicate-work",
  "duplicate-page",
  "missing-chapter",
] as const)(
  "rejects %s without trying to repair or delete the work",
  async (kind) => {
    const f = await workDeletionFixture();
    try {
      if (kind === "unlisted-directory")
        await mkdir(join(f.workDirectory, "chapters", "unlisted"));
      else if (kind === "duplicate-work")
        await writeFile(
          f.indexPath,
          JSON.stringify({ workOrder: ["work", "work", "destination"] }),
        );
      else if (kind === "missing-chapter") {
        const work = { ...f.source.work, chapterOrder: ["chapter", "missing"] };
        await writeFile(
          join(f.workDirectory, "work.json"),
          JSON.stringify(work),
        );
      } else {
        const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
        chapter.pageOrder = [...chapter.pageOrder, chapter.pageOrder[0]];
        await writeFile(f.chapterPath, JSON.stringify(chapter));
      }
      const before = await f.captureWork();
      await expect(f.previewWork()).rejects.toThrow();
      expect(await f.captureWork()).toEqual(before);
      expect((await f.storage.index()).entries).toEqual([]);
    } finally {
      await f.close();
    }
  },
);
