import { readFile, lstat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { chapterMoveFixture } from "./mcpChapterMove.fixture";

it("moves a closed chapter once with native unique naming and restores exact bytes and both work orders after restart", async () => {
  const f = await chapterMoveFixture();
  try {
    const review = await f.previewMove();
    expect(review).toMatchObject({
      eligible: true,
      sourceChapterIds: [],
      destinationChapterIds: ["chapter", "dest-chapter"],
      memoryPresent: false,
    });
    expect(review.afterTitle).not.toBe(review.beforeTitle);
    expect(JSON.stringify(review)).not.toMatch(
      /imagePath|sourceText|translatedText|dataUrl|large\.bin/,
    );
    expect((await f.storage.index()).entries).toEqual([]);
    const input = await f.commandMove();
    const receipt = await f.applyMove(input);
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    const moved = await f.library.openChapter("chapter");
    expect(moved).toMatchObject({
      workId: "destination",
      id: "chapter",
      title: review.afterTitle,
      pageOrder: f.source.chapter.pageOrder,
    });
    for (const [index, page] of moved.pages.entries()) {
      expect(page.blocks).toEqual(f.source.chapter.pages[index].blocks);
      expect(relative(f.destinationRoot, page.imagePath).startsWith("..")).toBe(
        false,
      );
      expect(await readFile(page.imagePath)).toEqual(
        f.original.get(`pages/${page.id}.png`),
      );
    }
    expect(f.notify).toHaveBeenCalledTimes(2);
    await f.restart();
    expect((await f.inspectMove(receipt.id)).canUndo).toBe(true);
    expect(await f.applyMove(input)).toMatchObject({
      id: receipt.id,
      historical: true,
    });
    expect(await f.call("carrot_list_chapter_moves", {})).toMatchObject({
      total: 1,
      items: [{ id: receipt.id, kind: "chapter-move" }],
    });
    const undo = await f.recoverMove(receipt.id, "undo");
    await f.assertMoveRestored();
    expect(await f.call("carrot_undo_chapter_move", undo.input)).toMatchObject({
      historical: true,
    });
    expect(await f.applyMove(input)).toMatchObject({ historical: true });
    await f.assertMoveRestored();
    await f.restart();
    await f.recoverMove(receipt.id, "redo");
    expect((await f.library.openChapter("chapter")).workId).toBe("destination");
    await f.recoverMove(receipt.id, "undo");
    await f.assertMoveRestored();
    await f.genericDiscard(receipt.id);
    await f.assertMoveRestored();
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});

it("preserves manual memory and exact original bytes across movement and recovery", async () => {
  const f = await chapterMoveFixture();
  try {
    const memory = {
      schemaVersion: 1,
      workId: "work",
      chapterId: "chapter",
      updatedAt: "manual-time",
      pages: [
        {
          pageId: "page",
          pageName: "Manual name",
          pageIndex: 0,
          sourceDigest: "Original",
          translatedDigest: "Saved",
          summary: "Manual summary",
          visualSummary: "Manual scene description",
          visualSummarySource: "manual",
          updatedAt: "manual-time",
        },
      ],
    };
    const memoryPath = join(f.directory, "story-memory.json");
    const originalBytes = JSON.stringify(memory);
    await writeFile(memoryPath, originalBytes);
    const receipt = await f.applyMove(await f.commandMove());
    const movedPath = join(
      f.destinationRoot,
      "chapters",
      "chapter",
      "story-memory.json",
    );
    expect(JSON.parse(await readFile(movedPath, "utf8"))).toEqual({
      ...memory,
      workId: "destination",
    });
    await f.restart();
    await f.recoverMove(receipt.id, "undo");
    expect(await readFile(memoryPath, "utf8")).toBe(originalBytes);
    await f.recoverMove(receipt.id, "redo");
    expect(JSON.parse(await readFile(movedPath, "utf8")).pages).toEqual(
      memory.pages,
    );
  } finally {
    await f.close();
  }
});

it("rejects changed review targets, other owners and later destination edits without forced restoration", async () => {
  const f = await chapterMoveFixture();
  try {
    const input = await f.commandMove();
    await expect(
      f.applyMove({ ...input, planFingerprint: "0".repeat(16) }),
    ).rejects.toThrow();
    await f.library.renameWork("destination", "Changed after review");
    await expect(f.applyMove(input)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    const saved = await f.applyMove(await f.commandMove());
    await expect(
      f.call("carrot_get_chapter_move", { id: saved.id }, f.auth("other")),
    ).rejects.toThrow();
    expect(
      await f.call("carrot_list_chapter_moves", {}, f.auth("other")),
    ).toMatchObject({ total: 0 });
    await f.library.renameChapter("dest-chapter", "Later sibling title");
    expect(await f.inspectMove(saved.id)).toMatchObject({
      canUndo: false,
      canRedo: false,
    });
    await expect(f.recoverMove(saved.id, "undo")).rejects.toThrow();
    expect((await f.library.openChapter("chapter")).workId).toBe("destination");
    expect((await f.library.openChapter("dest-chapter")).title).toBe(
      "Later sibling title",
    );
  } finally {
    await f.close();
  }
});
