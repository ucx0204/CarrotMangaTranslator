import { expect, it } from "vitest";
import { workDeletionFixture } from "./mcpWorkDeletion.fixture";

it.each([
  "after-publish-step",
  "after-replace-step",
  "after-retire-step",
  "after-commit-point",
] as const)(
  "recovers the complete work and retained index after %s interruption",
  async (point) => {
    const f = await workDeletionFixture();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const { recoverLibraryTransactions } =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let reset: (() => void) | undefined;
    try {
      const input = await f.commandWork();
      let injected = false;
      reset = tx.setLibraryTransactionCrashInjectorForTests((actual) => {
        if (!injected && point === actual) {
          injected = true;
          throw new tx.SimulatedLibraryTransactionCrash(actual);
        }
      });
      await expect(f.applyWork(input)).rejects.toBeInstanceOf(
        tx.SimulatedLibraryTransactionCrash,
      );
      reset();
      reset = undefined;
      expect(injected).toBe(true);
      await recoverLibraryTransactions();
      await f.restart();
      if (point === "after-commit-point") {
        const receipt = await f.applyWork(input);
        expect(receipt.historical).toBe(true);
        await f.recoverWork(receipt.id, "undo");
      } else expect((await f.storage.index()).entries).toEqual([]);
      await f.assertWorkOriginal();
      await f.assertOriginal();
      expect(f.app.jobs.gate.activities).toEqual([]);
    } finally {
      reset?.();
      await f.close();
    }
  },
);
