import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ChapterMoveRecordSchema } from "../src/main/application/mcpChapterMoveState";
import { chapterMoveFixture } from "./mcpChapterMove.fixture";

it.each([
  "encryption",
  "revocation",
  "expiry",
  "session-stop",
  "editor-open",
  "source-edit",
] as const)(
  "preserves source, destination and recovery catalog when late %s prevents movement",
  async (failure) => {
    const f = await chapterMoveFixture();
    let authorized = true;
    try {
      const input = await f.commandMove();
      const seal = f.codec.seal.bind(f.codec);
      let injected = false;
      const note = join(f.directory, "runs", "preserved", "note.txt");
      vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
        const result = await seal(value);
        const parsed = ChapterMoveRecordSchema.safeParse(value);
        if (parsed.success && !injected) {
          injected = true;
          if (failure === "encryption")
            throw new Error("Move encryption failed");
          if (failure === "revocation") authorized = false;
          if (failure === "expiry") f.clock(parsed.data.expiresAt);
          if (failure === "session-stop") f.organization().stop();
          if (failure === "editor-open") f.editorOpen("chapter");
          if (failure === "source-edit")
            await writeFile(note, "Newer user input");
        }
        return result;
      });
      await expect(
        f.applyMove(
          input,
          f.auth("import-owner", () => {
            if (!authorized) throw new Error("Revoked move grant");
          }),
        ),
      ).rejects.toThrow();
      vi.restoreAllMocks();
      expect(injected).toBe(true);
      if (failure === "source-edit") {
        expect(await readFile(note, "utf8")).toBe("Newer user input");
        for (const [path, bytes] of f.original)
          if (join(f.directory, path) !== note)
            expect(await readFile(join(f.directory, path))).toEqual(bytes);
      } else await f.assertMoveRestored();
      await expect(
        lstat(join(f.destinationRoot, "chapters", "chapter")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await f.storage.index()).entries).toEqual([]);
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.app.jobs.gate.activities).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it("rejects encrypted recovery-byte corruption before moving any source", async () => {
  const f = await chapterMoveFixture();
  try {
    const seal = f.codec.seal.bind(f.codec);
    let injected = false;
    vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      if (!injected && value && typeof value === "object" && "chunk" in value) {
        injected = true;
        return seal({
          chunk: Buffer.from("Corrupt archived original").toString("base64"),
        });
      }
      return seal(value);
    });
    await expect(f.applyMove(await f.commandMove())).rejects.toThrow(
      /inconsistent/,
    );
    vi.restoreAllMocks();
    expect(injected).toBe(true);
    await f.assertMoveRestored();
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it("leaves a moved chapter and original recovery intact when the Undo record cannot be saved", async () => {
  const f = await chapterMoveFixture();
  try {
    const saved = await f.applyMove(await f.commandMove());
    const before = await f.storage.record(saved.id);
    const seal = f.codec.seal.bind(f.codec);
    vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const record = ChapterMoveRecordSchema.safeParse(value);
      if (record.success && record.data.actions.length)
        throw new Error("Undo record failure");
      return seal(value);
    });
    await expect(f.recoverMove(saved.id, "undo")).rejects.toThrow(
      /Undo record failure/,
    );
    vi.restoreAllMocks();
    expect(await f.storage.record(saved.id)).toEqual(before);
    expect((await f.library.openChapter("chapter")).workId).toBe("destination");
    expect((await f.inspectMove(saved.id)).canUndo).toBe(true);
    await f.recoverMove(saved.id, "undo");
    await f.assertMoveRestored();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it("rejects corrupted after metadata during inspection and actual recovery", async () => {
  const f = await chapterMoveFixture();
  try {
    const saved = await f.applyMove(await f.commandMove());
    const record = ChapterMoveRecordSchema.parse(
      await f.storage.record(saved.id),
    );
    const altered = structuredClone(record);
    altered.afterChapter.pages[0].blocks[0].translatedText =
      "Forged translation";
    await writeFile(
      await f.storage.path(saved.id),
      JSON.stringify(await f.codec.seal(altered)),
    );
    await expect(f.inspectMove(saved.id)).rejects.toThrow(/byte inventory/);
    await expect(
      f.call("carrot_undo_chapter_move", {
        id: saved.id,
        snapshot: saved.snapshot,
        requestId: crypto.randomUUID(),
        confirm: true,
      }),
    ).rejects.toThrow();
    expect((await f.library.openChapter("chapter")).pages[0].blocks).toEqual(
      f.source.chapter.pages[0].blocks,
    );
    await writeFile(
      await f.storage.path(saved.id),
      JSON.stringify(await f.codec.seal(record)),
    );
    await f.recoverMove(saved.id, "undo");
    await f.assertMoveRestored();
  } finally {
    await f.close();
  }
});
