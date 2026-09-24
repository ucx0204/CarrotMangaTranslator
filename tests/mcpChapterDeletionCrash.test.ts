import { lstat } from "node:fs/promises";
import { expect, it } from "vitest";
import { chapterDeletionFixture } from "./mcpChapterDeletion.fixture";

it.each([
  "after-replace-step",
  "after-retire-step",
  "after-commit-point",
] as const)(
  "recovers chapter removal and its encrypted record as one state after %s",
  async (point) => {
    const f = await chapterDeletionFixture();
    const transaction =
      await import("../src/main/libraryStore/libraryTransaction");
    const recovery =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let restore: (() => void) | undefined;
    try {
      const input = await f.command();
      let crashed = false;
      restore = transaction.setLibraryTransactionCrashInjectorForTests(
        (actual) => {
          if (!crashed && actual === point) {
            crashed = true;
            throw new transaction.SimulatedLibraryTransactionCrash(actual);
          }
        },
      );
      await expect(f.apply(input)).rejects.toBeInstanceOf(
        transaction.SimulatedLibraryTransactionCrash,
      );
      restore();
      restore = undefined;
      expect(crashed).toBe(true);
      await recovery.recoverLibraryTransactions();
      await f.restart();
      if (point === "after-commit-point") {
        const repeated = await f.apply(input);
        expect(repeated.historical).toBe(true);
        await expect(lstat(f.directory)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect((await f.inspect(repeated.id)).canUndo).toBe(true);
        await f.recover(repeated.id, "undo");
        await f.assertOriginal();
      } else {
        await f.assertOriginal();
        expect((await f.storage.index()).entries).toEqual([]);
      }
      expect(f.app.jobs.gate.activities).toEqual([]);
    } finally {
      restore?.();
      await f.close();
    }
  },
);
