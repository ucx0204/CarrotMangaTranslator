import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { contextMigrationAppFixture } from "./mcpContextMigrationApp.fixture";
import { mcpContextMigrationOutputs } from "../src/shared/mcpContextMigration";

it("atomically migrates multiple chapters and orphan memories, then restores exact references after restart", async () => {
  const f = await contextMigrationAppFixture();
  try {
    const before = await f.graph();
    const original = await readFile(
      before.chapters[0].chapter.pages[0].imagePath,
    );
    const result = await f.apply();
    expect(result).toMatchObject({
      status: "saved",
      historical: false,
      changes: { guideChanged: true, pages: 2, blocks: 2, memories: 1 },
    });
    const saved = await f.graph();
    expect(saved.styleGuide.characters.map((entry) => entry.id)).toEqual([
      "destination",
    ]);
    for (const [index, item] of saved.chapters.entries()) {
      expect(item.chapter.pages[0].blocks[0]).toEqual({
        ...before.chapters[index].chapter.pages[0].blocks[0],
        speakerId: "destination",
      });
      expect(item.chapter.pages[0].blocks.slice(1)).toEqual(
        before.chapters[index].chapter.pages[0].blocks.slice(1),
      );
    }
    expect(saved.chapters[1].storyMemory.pages[0]).toMatchObject({
      pageId: "orphan",
      characterIds: ["destination"],
      summary: "Private story",
    });
    expect((await f.inspect(result.id)).canUndo).toBe(true);
    expect(result.referenceSnapshot).toBe(
      (await f.inspect(result.id)).referenceSnapshot,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /Private|imagePath|sourceText|translatedText/,
    );
    const list =
      mcpContextMigrationOutputs.carrot_list_context_migrations.parse(
        await f.invoke("carrot_list_context_migrations", {}),
      );
    expect(list.items.map((item) => item.id)).toEqual([result.id]);
    await f.restart();
    await f.recover(result.id, "undo");
    const undone = await f.graph();
    expect(undone.styleGuide).toEqual(before.styleGuide);
    for (const [index, item] of undone.chapters.entries()) {
      expect(item.chapter.pages.map((page) => page.blocks)).toEqual(
        before.chapters[index].chapter.pages.map((page) => page.blocks),
      );
      expect(item.storyMemory.pages).toEqual(
        before.chapters[index].storyMemory.pages,
      );
    }
    expect((await f.inspect(result.id)).canRedo).toBe(true);
    await f.restart();
    await f.recover(result.id, "redo");
    expect((await f.graph()).styleGuide).toEqual(saved.styleGuide);
    expect(
      await readFile(before.chapters[0].chapter.pages[0].imagePath),
    ).toEqual(original);
  } finally {
    await f.close();
  }
});

it("replays original apply and recovery receipts without overwriting the current restored state", async () => {
  const f = await contextMigrationAppFixture();
  try {
    const input = await f.input();
    const applied = await f.apply(input);
    const undo = await f.recoverInput(applied.id);
    await f.invoke("carrot_undo_context_migration", undo);
    const bytes = await readFile(f.chapterPath);
    await f.restart();
    expect(await f.apply(input)).toMatchObject({
      id: applied.id,
      status: "already_applied",
      historical: true,
    });
    expect(await f.invoke("carrot_undo_context_migration", undo)).toMatchObject(
      { status: "already_applied", historical: true },
    );
    expect(await readFile(f.chapterPath)).toEqual(bytes);
    await expect(f.apply({ ...input, preserveManual: false })).rejects.toThrow(
      "requestId",
    );
    await expect(
      f.invoke("carrot_redo_context_migration", undo),
    ).rejects.toThrow("requestId");
    await expect(
      f.invoke(
        "carrot_undo_context_migration",
        await f.recoverInput(applied.id),
      ),
    ).rejects.toThrow("direction");
  } finally {
    await f.close();
  }
});

it("restores absent speaker properties and preserves unrelated optional fields after an explicit unlink", async () => {
  const f = await contextMigrationAppFixture();
  try {
    const before = await f.graph();
    const input = await f.input({
      kind: "delete",
      entity: "character",
      entryIds: ["character"],
      unlinkReferences: true,
    });
    const result = await f.apply(input);
    expect(
      (await f.graph()).chapters[0].chapter.pages[0].blocks[0],
    ).not.toHaveProperty("speakerId");
    await f.recover(result.id, "undo");
    expect((await f.graph()).chapters[0].chapter.pages[0].blocks).toEqual(
      before.chapters[0].chapter.pages[0].blocks,
    );
  } finally {
    await f.close();
  }
});

it("restores an originally absent catalog file without creating empty memory files", async () => {
  const f = await contextMigrationAppFixture();
  try {
    const path = join(f.env.libraryDir, "works", "work", "style-guide.json");
    const memory = join(
      f.env.libraryDir,
      "works",
      "work",
      "chapters",
      "chapter",
      "story-memory.json",
    );
    await unlink(path);
    await expect(readFile(memory)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await f.apply(
      await f.input({
        kind: "replace-glossary",
        entries: [
          {
            id: "term",
            source: "word",
            target: "번역",
            category: "term",
            enabled: true,
          },
        ],
      }),
    );
    expect(result.changes).toEqual({
      guideChanged: true,
      pages: 0,
      blocks: 0,
      memories: 0,
    });
    await f.restart();
    await f.recover(result.id, "undo");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(memory)).rejects.toMatchObject({ code: "ENOENT" });
    await f.library.saveWorkStyleGuide(
      await f.library.getWorkStyleGuide("work"),
    );
    expect((await f.inspect(result.id)).canRedo).toBe(false);
    await expect(f.recover(result.id, "redo")).rejects.toThrow(
      "catalog file presence changed",
    );
    await unlink(path);
    await f.recover(result.id, "redo");
    expect((await f.graph()).styleGuide.glossary[0].target).toBe("번역");
  } finally {
    await f.close();
  }
});

it("refuses stale intent and later dialogue edits instead of forcing an old whole-work snapshot", async () => {
  const f = await contextMigrationAppFixture();
  try {
    const input = await f.input();
    await expect(
      f.apply({ ...input, planFingerprint: "0".repeat(16) }),
    ).rejects.toThrow("intent changed");
    const applied = await f.apply(input);
    const chapter = await f.library.openChapter("chapter-two");
    const page = chapter.pages[1];
    await f.library.savePageBlocks({
      chapterId: chapter.id,
      pageId: page.id,
      blocks: page.blocks.map((block) => ({
        ...block,
        translatedText: "later user edit",
      })),
    });
    expect((await f.inspect(applied.id)).canUndo).toBe(false);
    await expect(f.recover(applied.id, "undo")).rejects.toThrow("changed");
    expect(
      (await f.library.openChapter("chapter-two")).pages[1].blocks[0]
        .translatedText,
    ).toBe("later user edit");
    await expect(
      f.apply({ ...input, requestId: randomUUID() }),
    ).rejects.toThrow("changed");
  } finally {
    await f.close();
  }
});

it("rejects other owners and raw snapshot inputs while preserving a committed receipt after notification failure", async () => {
  const f = await contextMigrationAppFixture();
  try {
    const input = await f.input();
    await expect(
      f.invoke("carrot_apply_context_migration", { ...input, rawSnapshot: {} }),
    ).rejects.toThrow("arguments");
    f.editing.notifySaved.mockImplementationOnce(() => {
      throw new Error("Synthetic notification failure");
    });
    const applied = await f.apply(input);
    expect(applied.warnings).toContain("notification_failed_after_commit");
    await expect(
      f.invoke(
        "carrot_get_context_migration",
        { id: applied.id },
        f.auth("other"),
      ),
    ).rejects.toThrow("another connection");
    const list = await f.invoke(
      "carrot_list_context_migrations",
      {},
      f.auth("other"),
    );
    expect(list).toMatchObject({ items: [], total: 0 });
    await f.recover(applied.id, "undo");
    expect((await f.inspect(applied.id)).canRedo).toBe(true);
  } finally {
    await f.close();
  }
});

it("records unchanged intent without rewriting page or catalog bytes and never offers meaningless undo", async () => {
  const f = await contextMigrationAppFixture();
  try {
    const before = await readFile(f.chapterPath);
    const guide = (await f.graph()).styleGuide;
    const entries = guide.characters.map(
      ({
        createdAt: _created,
        updatedAt: _updated,
        origin: _origin,
        ...entry
      }) => entry,
    );
    const input = await f.input({ kind: "replace-characters", entries });
    const result = await f.apply(input);
    expect(result.status).toBe("unchanged");
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect((await f.graph()).styleGuide).toEqual(guide);
    expect(await f.inspect(result.id)).toMatchObject({
      canUndo: false,
      canRedo: false,
    });
    expect((await f.apply(input)).status).toBe("already_applied");
  } finally {
    await f.close();
  }
});
