import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ChapterMoveRecordSchema } from "../src/main/application/mcpChapterMoveState";
import { chapterMoveFixture } from "./mcpChapterMove.fixture";
import { migrationFixture } from "./mcpContextMigration.fixture";

it("preserves a destination guide created after archive preparation instead of publishing under unreviewed context", async () => {
  const f = await chapterMoveFixture();
  try {
    const input = await f.commandMove();
    const path = join(f.destinationRoot, "style-guide.json");
    const guide = {
      ...migrationFixture().graph.styleGuide,
      workId: "destination",
    };
    const bytes = JSON.stringify(guide);
    const seal = f.codec.seal.bind(f.codec);
    let injected = false;
    vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const encoded = await seal(value);
      if (!injected && ChapterMoveRecordSchema.safeParse(value).success) {
        injected = true;
        // A real out-of-process write; no native movement or transaction mocks.
        await writeFile(path, bytes);
      }
      return encoded;
    });
    await expect(f.applyMove(input)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    vi.restoreAllMocks();
    expect(injected).toBe(true);
    expect(await readFile(path, "utf8")).toBe(bytes);
    await f.assertMoveRestored();
    expect((await f.storage.index()).entries).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
    // A fresh review of the new destination context can proceed normally.
    const saved = await f.applyMove(await f.commandMove());
    await f.recoverMove(saved.id, "undo");
    await f.assertMoveRestored();
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it("discards only movement recovery while keeping the ordinary moved chapter and all files across reconstruction", async () => {
  const f = await chapterMoveFixture();
  try {
    const saved = await f.applyMove(await f.commandMove());
    const directory = join(f.destinationRoot, "chapters", "chapter");
    const before = await f.files.captureChapterDeletionTree(
      directory,
      () => {},
    );
    const chapter = await f.library.openChapter("chapter");
    const catalog = await f.library.listLibrary();
    await f.genericDiscard(saved.id);
    await f.restart();
    await expect(f.inspectMove(saved.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await f.call("carrot_list_chapter_moves", {})).toMatchObject({
      total: 0,
    });
    expect(
      await f.files.captureChapterDeletionTree(directory, () => {}),
    ).toEqual(before);
    expect(await f.library.openChapter("chapter")).toEqual(chapter);
    expect(await f.library.listLibrary()).toEqual(catalog);
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of f.originals)
      expect((await readFile(path)).length).toBeGreaterThan(0);
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});
