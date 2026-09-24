import { expect, it } from "vitest";
import { chapterMoveFixture } from "./mcpChapterMove.fixture";

it.each([
  "after-publish-step",
  "after-replace-step",
  "after-retire-step",
  "after-commit-point",
] as const)(
  "recovers both work orders, chapter location and retained receipt after %s",
  async (point) => {
    const f = await chapterMoveFixture();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const recovery =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let restore: (() => void) | undefined;
    try {
      const input = await f.commandMove();
      let crashed = false;
      restore = tx.setLibraryTransactionCrashInjectorForTests((actual) => {
        if (!crashed && point === actual) {
          crashed = true;
          throw new tx.SimulatedLibraryTransactionCrash(actual);
        }
      });
      await expect(f.applyMove(input)).rejects.toBeInstanceOf(
        tx.SimulatedLibraryTransactionCrash,
      );
      restore();
      restore = undefined;
      expect(crashed).toBe(true);
      await recovery.recoverLibraryTransactions();
      await f.restart();
      if (point === "after-commit-point") {
        const saved = await f.applyMove(input);
        expect(saved.historical).toBe(true);
        expect((await f.library.openChapter("chapter")).workId).toBe(
          "destination",
        );
        await f.recoverMove(saved.id, "undo");
      } else expect((await f.storage.index()).entries).toEqual([]);
      await f.assertMoveRestored();
      expect(f.app.jobs.gate.activities).toEqual([]);
    } finally {
      restore?.();
      await f.close();
    }
  },
);
