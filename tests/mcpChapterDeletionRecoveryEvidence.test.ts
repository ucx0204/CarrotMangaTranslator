import { readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, it, vi } from "vitest";
import { ChapterDeletionRecordSchema } from "../src/main/application/mcpChapterDeletionState";
import { chapterDeletionFixture } from "./mcpChapterDeletion.fixture";

it.each(["record", "index"] as const)(
  "preserves the original chapter when the encrypted %s does not round-trip",
  async (part) => {
    const f = await chapterDeletionFixture();
    try {
      const input = await f.command();
      const seal = f.codec.seal.bind(f.codec);
      let injected = false;
      vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
        const record = ChapterDeletionRecordSchema.safeParse(value);
        const index =
          typeof value === "object" && value !== null && "entries" in value;
        if (!injected && (part === "record" ? record.success : index)) {
          injected = true;
          // The external codec succeeds but produces readable, incorrect metadata.
          return seal(
            part === "record" ? { damaged: true } : { version: 1, entries: [] },
          );
        }
        return seal(value);
      });
      await expect(f.apply(input)).rejects.toThrow(
        /metadata|recovery|encrypt/i,
      );
      vi.restoreAllMocks();
      expect(injected).toBe(true);
      await f.assertOriginal();
      expect((await f.storage.index()).entries).toEqual([]);
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.app.jobs.gate.activities).toEqual([]);
      const saved = await f.apply(input);
      await f.recover(saved.id, "undo");
      await f.assertOriginal();
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it("rechecks written recovery metadata before retiring original files", async () => {
  const f = await chapterDeletionFixture();
  try {
    const input = await f.command();
    const seal = f.codec.seal.bind(f.codec);
    let injected = false;
    vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      if (
        !injected &&
        typeof value === "object" &&
        value !== null &&
        "entries" in value
      ) {
        injected = true;
        const transactions = join(f.env.libraryDir, ".transactions");
        const records = (
          await readdir(transactions, { recursive: true })
        ).filter((path) => basename(path) === "record.json");
        expect(records).toHaveLength(1);
        // Emulate an out-of-process edit after write but before native publication.
        await writeFile(
          join(transactions, records[0]),
          JSON.stringify(await seal({ damaged: true })),
        );
      }
      return seal(value);
    });
    await expect(f.apply(input)).rejects.toThrow(/metadata|recovery/i);
    vi.restoreAllMocks();
    expect(injected).toBe(true);
    await f.assertOriginal();
    expect((await f.storage.index()).entries).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
