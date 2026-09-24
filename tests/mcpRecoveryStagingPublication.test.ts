import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ChapterMoveRecordSchema } from "../src/main/application/mcpChapterMoveState";
import { workDeletionFixture } from "./mcpWorkDeletion.fixture";

it("rejects changed staged movement bytes before publication and keeps the moved chapter and recovery usable", async () => {
  const f = await workDeletionFixture();
  try {
    const saved = await f.applyMove(await f.commandMove());
    const originalRecord = await f.storage.record(saved.id);
    const directory = join(f.destinationRoot, "chapters", "chapter");
    const originalTree = await f.files.captureChapterDeletionTree(
      directory,
      () => {},
    );
    const seal = f.codec.seal.bind(f.codec);
    let injected = false;
    vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const record = ChapterMoveRecordSchema.safeParse(value);
      if (record.success && record.data.actions.length === 1 && !injected) {
        injected = true;
        // Mutate the real transaction's temporary content at the encryption boundary.
        // Native movement, ownership, hashing and publication are not mocked.
        const staging = join(f.env.libraryDir, ".transactions");
        const files = (await readdir(staging, { recursive: true })).filter(
          (path) => /[\\/]chapter\.json$/u.test(path),
        );
        expect(files).toHaveLength(1);
        await writeFile(join(staging, files[0]), "Changed staged chapter");
      }
      return seal(value);
    });
    await expect(f.recoverMove(saved.id, "undo")).rejects.toThrow(
      /Staged moved\/restored chapter differs/,
    );
    vi.restoreAllMocks();
    expect(injected).toBe(true);
    expect(await f.storage.record(saved.id)).toEqual(originalRecord);
    expect(
      await f.files.captureChapterDeletionTree(directory, () => {}),
    ).toEqual(originalTree);
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.inspectMove(saved.id)).canUndo).toBe(true);
    await f.restart();
    await f.recoverMove(saved.id, "undo");
    await f.assertMoveRestored();
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it("refuses a retained catalog that disagrees with the encrypted work record without restoring or discarding data", async () => {
  const f = await workDeletionFixture();
  try {
    const saved = await f.applyWork(await f.commandWork());
    const originalRecord = await f.storage.record(saved.id);
    const path = await f.storage.path();
    const originalIndex = await readFile(path);
    const index = await f.storage.index();
    const entry = index.entries.find((item) => item.id === saved.id);
    if (!entry) throw new Error("Missing fixture-owned work recovery");
    entry.operation = "another-operation";
    await writeFile(path, JSON.stringify(await f.codec.seal(index)));
    const mismatchedIndex = await readFile(path);
    await f.restart();
    await expect(f.inspectWork(saved.id)).rejects.toMatchObject({
      code: "invalid_edit",
    });
    await expect(
      f.call("carrot_undo_work_deletion", {
        id: saved.id,
        snapshot: saved.snapshot,
        requestId: randomUUID(),
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    await expect(
      f.call("carrot_discard_work_deletion", {
        id: saved.id,
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    expect(await readFile(path)).toEqual(mismatchedIndex);
    expect(await f.storage.record(saved.id)).toEqual(originalRecord);
    await expect(lstat(f.workDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(path, originalIndex);
    await f.recoverWork(saved.id, "undo");
    await f.assertWorkOriginal();
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    await f.close();
  }
});
