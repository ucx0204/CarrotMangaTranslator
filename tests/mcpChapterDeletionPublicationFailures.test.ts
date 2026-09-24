import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ChapterDeletionRecordSchema } from "../src/main/application/mcpChapterDeletionState";
import { chapterDeletionFixture } from "./mcpChapterDeletion.fixture";

it.each([
  "encryption",
  "revocation",
  "expiry",
  "session-stop",
  "editor-open",
  "source-edit",
] as const)(
  "publishes neither deletion nor recovery history after late %s",
  async (failure) => {
    const f = await chapterDeletionFixture();
    let authorized = true;
    try {
      const input = await f.command();
      const original = f.codec.seal.bind(f.codec);
      let injected = false;
      const changed = join(f.directory, "runs", "preserved", "note.txt");
      vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
        const result = await original(value);
        const parsed = ChapterDeletionRecordSchema.safeParse(value);
        if (parsed.success && !injected) {
          injected = true;
          if (failure === "encryption")
            throw new Error("Encryption unavailable");
          if (failure === "revocation") authorized = false;
          if (failure === "expiry") f.clock(parsed.data.expiresAt);
          if (failure === "session-stop") f.organization().stop();
          if (failure === "editor-open") f.editorOpen("chapter");
          if (failure === "source-edit")
            await writeFile(changed, "Later external fixture edit");
        }
        return result;
      });
      await expect(
        f.apply(
          input,
          f.auth("import-owner", () => {
            if (!authorized) throw new Error("Fixture approval revoked");
          }),
        ),
      ).rejects.toThrow();
      vi.restoreAllMocks();
      expect(injected).toBe(true);
      if (failure === "source-edit") {
        expect(await readFile(changed, "utf8")).toBe(
          "Later external fixture edit",
        );
        for (const [path, bytes] of f.original) {
          if (join(f.directory, path) !== changed)
            expect(await readFile(join(f.directory, path))).toEqual(bytes);
        }
      } else await f.assertOriginal();
      expect((await f.storage.index()).entries).toEqual([]);
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.app.jobs.gate.activities).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it("decodes and verifies the encrypted recovery copy before deleting the original", async () => {
  const f = await chapterDeletionFixture();
  try {
    const original = f.codec.seal.bind(f.codec);
    let injected = false;
    vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      if (
        !injected &&
        typeof value === "object" &&
        value !== null &&
        "chunk" in value
      ) {
        injected = true;
        return original({
          chunk: Buffer.from("Incorrect recovered bytes").toString("base64"),
        });
      }
      return original(value);
    });
    await expect(f.apply(await f.command())).rejects.toThrow(/inconsistent/);
    vi.restoreAllMocks();
    expect(injected).toBe(true);
    await f.assertOriginal();
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it("rolls back a failed restore and leaves its original encrypted recovery usable", async () => {
  const f = await chapterDeletionFixture();
  try {
    const saved = await f.apply(await f.command());
    const before = await f.storage.record(saved.id);
    const original = f.codec.seal.bind(f.codec);
    vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const record = ChapterDeletionRecordSchema.safeParse(value);
      if (record.success && record.data.actions.length)
        throw new Error("Restore record seal failed");
      return original(value);
    });
    await expect(f.recover(saved.id, "undo")).rejects.toThrow(/seal failed/);
    vi.restoreAllMocks();
    expect(await f.storage.record(saved.id)).toEqual(before);
    expect((await f.inspect(saved.id)).canUndo).toBe(true);
    await f.recover(saved.id, "undo");
    await f.assertOriginal();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
