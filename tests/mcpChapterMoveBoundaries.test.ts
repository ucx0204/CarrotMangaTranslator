import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { chapterMoveFixture } from "./mcpChapterMove.fixture";
import { McpChapterMoveApplySchema } from "../src/shared/mcpChapterMove";

it("rejects malformed scope and incomplete confirmation without touching either work", async () => {
  const f = await chapterMoveFixture();
  try {
    for (const intent of [
      { ...f.intent, destinationWorkId: "work" },
      { ...f.intent, beforeChapterId: "missing" },
      { ...f.intent, workId: "../work" },
      { ...f.intent, path: "C:/private" },
      {
        ...f.intent,
        references: [
          { kind: "glossary", sourceId: "a", targetId: "b" },
          { kind: "glossary", sourceId: "a", targetId: "c" },
        ],
      },
    ])
      await expect(
        f.call("carrot_preview_chapter_move", { intent }),
      ).rejects.toThrow();
    const input = await f.commandMove();
    for (const confirm of [true, false, "", "move"])
      expect(
        McpChapterMoveApplySchema.safeParse({ ...input, confirm }).success,
      ).toBe(false);
    f.editorOpen("chapter");
    await expect(f.applyMove(input)).rejects.toMatchObject({
      code: "editor_busy",
    });
    await f.assertMoveRestored();
    expect((await f.storage.index()).entries).toEqual([]);
    f.preferences.allowProcessing = false;
    await f.restart();
    expect(
      f
        .organization()
        .tools.filter(
          (tool) =>
            tool.name.includes("chapter_move") ||
            tool.name === "carrot_move_chapter",
        )
        .every((tool) => tool.readOnly),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it("requires a trusted editor probe and never interprets missing probes as permission to move", async () => {
  const f = await chapterMoveFixture(false);
  try {
    await expect(f.applyMove(await f.commandMove())).rejects.toMatchObject({
      code: "editor_busy",
    });
    await f.assertMoveRestored();
  } finally {
    await f.close();
  }
});

it("keeps empty saved memory, local mask paths and all original payloads while invalidating context-specific checkpoints", async () => {
  const f = await chapterMoveFixture();
  try {
    const raw = JSON.parse(await readFile(f.chapterPath, "utf8"));
    const mask = join(f.directory, "pages", "mask.png");
    await writeFile(mask, f.bytes);
    raw.pages[0].inpaintMaskPath = mask;
    raw.pages[0].inpaintedImagePath = mask;
    raw.pages[0].maskProvenance = "actual-mask";
    raw.pages[0].fontContinuity = {
      schemaVersion: 1,
      runtimeContractVersion: "font-matching-continuity-v1",
      observations: [],
      savedAt: "2026-09-21T00:00:00.000Z",
    };
    await writeFile(f.chapterPath, JSON.stringify(raw));
    const memory = {
      schemaVersion: 1,
      workId: "work",
      chapterId: "chapter",
      pages: [],
      updatedAt: "empty-old",
    };
    const memoryPath = join(f.directory, "story-memory.json");
    await writeFile(memoryPath, JSON.stringify(memory));
    const review = await f.previewMove({
      ...f.intent,
      beforeChapterId: undefined,
    });
    expect(review).toMatchObject({
      memoryPresent: true,
      invalidatedCheckpoints: 1,
      destinationChapterIds: ["dest-chapter", "chapter"],
    });
    const saved = await f.applyMove(
      await f.commandMove({ ...f.intent, beforeChapterId: undefined }),
    );
    const moved = await f.library.openChapter("chapter");
    expect(moved.pages[0].fontContinuity).toBeUndefined();
    const { inpaintMaskPath, inpaintedImagePath } = moved.pages[0];
    if (!inpaintMaskPath || !inpaintedImagePath)
      throw new Error("Moved fixture lost its saved image paths");
    expect(await readFile(inpaintMaskPath)).toEqual(f.bytes);
    expect(await readFile(inpaintedImagePath)).toEqual(f.bytes);
    const nextMemory = JSON.parse(
      await readFile(
        join(f.destinationRoot, "chapters", "chapter", "story-memory.json"),
        "utf8",
      ),
    );
    expect(nextMemory).toEqual({ ...memory, workId: "destination" });
    await f.recoverMove(saved.id, "undo");
    expect(JSON.parse(await readFile(f.chapterPath, "utf8"))).toEqual(raw);
    expect(JSON.parse(await readFile(memoryPath, "utf8"))).toEqual(memory);
  } finally {
    await f.close();
  }
});

it("never overwrites an occupied restoration target and retains the moved chapter after recovery expires", async () => {
  const f = await chapterMoveFixture();
  try {
    const saved = await f.applyMove(await f.commandMove());
    await mkdir(f.directory);
    const later = join(f.directory, "later.txt");
    await writeFile(later, "User-owned occupied location");
    await expect(f.inspectMove(saved.id)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await expect(
      f.call("carrot_undo_chapter_move", {
        id: saved.id,
        snapshot: saved.snapshot,
        requestId: crypto.randomUUID(),
        confirm: true,
      }),
    ).rejects.toThrow();
    expect(await readFile(later, "utf8")).toBe("User-owned occupied location");
    f.clock(saved.expiresAt);
    await expect(f.inspectMove(saved.id)).rejects.toThrow();
    expect(await f.call("carrot_list_chapter_moves", {})).toMatchObject({
      items: [{ available: false }],
    });
    expect((await f.library.openChapter("chapter")).workId).toBe("destination");
  } finally {
    await f.close();
  }
});

it("does not turn post-commit notification failure into a failed or repeated move", async () => {
  const f = await chapterMoveFixture();
  try {
    f.notify.mockImplementation(() => {
      throw new Error("Renderer gone");
    });
    const input = await f.commandMove();
    const saved = await f.applyMove(input);
    expect(saved.warnings).toContain("notification_failed_after_commit");
    expect((await f.library.openChapter("chapter")).workId).toBe("destination");
    const count = f.notify.mock.calls.length;
    expect((await f.applyMove(input)).historical).toBe(true);
    expect(f.notify).toHaveBeenCalledTimes(count);
    f.notify.mockImplementation(() => {});
    await f.recoverMove(saved.id, "undo");
    await f.assertMoveRestored();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
