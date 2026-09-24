import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { memoryRefreshAppFixture } from "./mcpMemoryRefreshApp.fixture";

it("rolls back new memory and recovery when authority is revoked during encryption", async () => {
  const f = await memoryRefreshAppFixture();
  const caller = f.auth();
  let allowed = true;
  caller.assertAuthorized.mockImplementation(() => {
    if (!allowed) throw new Error("Approval revoked");
  });
  const seal = f.codec.seal;
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    const result = await seal(value);
    if (typeof value === "object" && value !== null && "delta" in value)
      allowed = false;
    return result;
  });
  try {
    const before = await readFile(f.chapterPath);
    await expect(
      f.invoke("carrot_apply_memory_refresh", await f.memoryInput(), caller),
    ).rejects.toThrow("revoked");
    expect(await readFile(f.chapterPath)).toEqual(before);
    await expect(
      stat(join(dirname(f.chapterPath), "story-memory.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    hook.mockRestore();
    await f.close();
  }
});

it("preserves concurrent raw page changes and rejects a stale memory after encrypted staging", async () => {
  const f = await memoryRefreshAppFixture();
  const seal = f.codec.seal;
  let changed = false;
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    const result = await seal(value);
    if (
      !changed &&
      typeof value === "object" &&
      value !== null &&
      "delta" in value
    ) {
      changed = true;
      const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
      chapter.pages[0].blocks[0].translatedText =
        "Concurrent text after staging";
      await writeFile(f.chapterPath, JSON.stringify(chapter));
    }
    return result;
  });
  try {
    await expect(f.refresh()).rejects.toThrow("metadata changed");
    expect(changed).toBe(true);
    expect(
      (await f.graph()).chapters[0].chapter.pages[0].blocks[0].translatedText,
    ).toBe("Concurrent text after staging");
    expect((await f.storage.index()).entries).toEqual([]);
    await expect(
      stat(join(dirname(f.chapterPath), "story-memory.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    hook.mockRestore();
    await f.close();
  }
});

for (const point of ["after-replace-step", "after-commit-point"] as const) {
  it(`recovers new memory-file presence and its owned receipt after ${point}`, async () => {
    const f = await memoryRefreshAppFixture();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const { recoverLibraryTransactions } =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let reset = () => {};
    try {
      const request = await f.memoryInput();
      const before = await readFile(f.chapterPath);
      let crashed = false;
      reset = tx.setLibraryTransactionCrashInjectorForTests((position) => {
        if (position === point) {
          crashed = true;
          throw new tx.SimulatedLibraryTransactionCrash(position);
        }
      });
      await f.refresh(request).catch((error: unknown) => {
        if (!(error instanceof tx.SimulatedLibraryTransactionCrash))
          throw error;
      });
      expect(crashed).toBe(true);
      reset();
      await recoverLibraryTransactions();
      await f.restart();
      const records = (await f.storage.index()).entries;
      if (point === "after-commit-point") {
        expect(records).toHaveLength(1);
        expect((await f.refresh(request)).status).toBe("already_applied");
        await f.recover(records[0].id, "undo");
      } else expect(records).toEqual([]);
      expect(await readFile(f.chapterPath)).toEqual(before);
      await expect(
        stat(join(dirname(f.chapterPath), "story-memory.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      reset();
      await f.close();
    }
  });
}
