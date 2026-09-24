import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { contextMigrationAppFixture } from "./mcpContextMigrationApp.fixture";

it("rolls back all context and reference files when approval is revoked during encrypted staging", async () => {
  const f = await contextMigrationAppFixture();
  const caller = f.auth();
  let authorized = true;
  caller.assertAuthorized.mockImplementation(() => {
    if (!authorized) throw new Error("Approval revoked");
  });
  const seal = f.codec.seal;
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    const sealed = await seal(value);
    if (typeof value === "object" && value !== null && "delta" in value)
      authorized = false;
    return sealed;
  });
  try {
    const before = await f.graph();
    const bytes = await readFile(f.chapterPath);
    const input = await f.input();
    await expect(
      f.invoke("carrot_apply_context_migration", input, caller),
    ).rejects.toThrow("revoked");
    expect(await readFile(f.chapterPath)).toEqual(bytes);
    expect((await f.graph()).styleGuide).toEqual(before.styleGuide);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    hook.mockRestore();
    await f.close();
  }
});

it("rechecks raw metadata after encryption and preserves a concurrent saved edit instead of publishing stale references", async () => {
  const f = await contextMigrationAppFixture();
  const seal = f.codec.seal;
  let changed = false;
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    const sealed = await seal(value);
    if (
      !changed &&
      typeof value === "object" &&
      value !== null &&
      "delta" in value
    ) {
      changed = true;
      const chapter = JSON.parse(await readFile(f.secondPath, "utf8"));
      chapter.pages[0].blocks[0].translatedText = "concurrent saved text";
      await writeFile(f.secondPath, JSON.stringify(chapter));
    }
    return sealed;
  });
  try {
    const before = (await f.graph()).styleGuide;
    await expect(f.apply()).rejects.toThrow("metadata changed");
    expect(changed).toBe(true);
    expect((await f.graph()).styleGuide).toEqual(before);
    expect(
      (await f.graph()).chapters[1].chapter.pages[0].blocks[0],
    ).toMatchObject({
      speakerId: "character",
      translatedText: "concurrent saved text",
    });
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    hook.mockRestore();
    await f.close();
  }
});

it("keeps dirty editor checks before any publication and stops a closed session", async () => {
  const f = await contextMigrationAppFixture();
  try {
    const before = await readFile(f.chapterPath);
    const input = await f.input();
    f.editing.assertWritable.mockRejectedValueOnce(
      new Error("Unsaved editor changes"),
    );
    await expect(f.apply(input)).rejects.toThrow("Unsaved editor");
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    await f.current().session.close();
    await expect(f.apply(input)).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

for (const point of ["after-replace-step", "after-commit-point"] as const) {
  it(`recovers the entire context/reference/receipt publication after ${point}`, async () => {
    const f = await contextMigrationAppFixture();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const { recoverLibraryTransactions } =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let reset = () => {};
    try {
      const before = await f.graph();
      const input = await f.input();
      let crashed = false;
      reset = tx.setLibraryTransactionCrashInjectorForTests((position) => {
        if (position === point) {
          crashed = true;
          throw new tx.SimulatedLibraryTransactionCrash(position);
        }
      });
      await f.apply(input).catch((error: unknown) => {
        if (!(error instanceof tx.SimulatedLibraryTransactionCrash))
          throw error;
      });
      expect(crashed).toBe(true);
      reset();
      await recoverLibraryTransactions();
      await f.restart();
      const records = (await f.storage.index()).entries.filter(
        (entry) => entry.kind === "context",
      );
      if (point === "after-commit-point") {
        expect(records).toHaveLength(1);
        expect((await f.apply(input)).status).toBe("already_applied");
        expect((await f.inspect(records[0].id)).canUndo).toBe(true);
        await f.recover(records[0].id, "undo");
      } else {
        expect(records).toEqual([]);
      }
      expect((await f.graph()).styleGuide).toEqual(before.styleGuide);
      expect((await f.graph()).chapters[1].storyMemory.pages).toEqual(
        before.chapters[1].storyMemory.pages,
      );
      for (const [index, item] of (await f.graph()).chapters.entries())
        expect(item.chapter.pages.map((page) => page.blocks)).toEqual(
          before.chapters[index].chapter.pages.map((page) => page.blocks),
        );
    } finally {
      reset();
      await f.close();
    }
  });
}
