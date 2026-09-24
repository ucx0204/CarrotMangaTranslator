import { expect, it } from "vitest";
import { pageDeletionFixture } from "./mcpPageDeletion.fixture";

it.each([
  "after-publish-step",
  "after-replace-step",
  "after-retire-step",
  "after-commit-point",
] as const)(
  "recovers page, artifacts, memory and encrypted receipt together after deletion interruption at %s",
  async (point) => {
    const f = await pageDeletionFixture();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const { recoverLibraryTransactions } =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let release: (() => void) | undefined;
    try {
      const input = await f.commandPage();
      let injected = false;
      release = tx.setLibraryTransactionCrashInjectorForTests((actual) => {
        if (!injected && actual === point) {
          injected = true;
          throw new tx.SimulatedLibraryTransactionCrash(actual);
        }
      });
      await expect(f.applyPage(input)).rejects.toBeInstanceOf(
        tx.SimulatedLibraryTransactionCrash,
      );
      release();
      release = undefined;
      expect(injected).toBe(true);
      await recoverLibraryTransactions();
      await f.restart();
      if (point === "after-commit-point") {
        const saved = await f.applyPage(input);
        expect(saved.historical).toBe(true);
        expect(
          (await f.library.openChapter(f.pageTarget.chapterId)).pages,
        ).toHaveLength(1);
        await f.recoverPage(saved.id, "undo");
      } else expect((await f.storage.index()).entries).toEqual([]);
      await f.assertPageOriginal();
      expect(f.app.jobs.gate.activities).toEqual([]);
    } finally {
      release?.();
      await f.close();
    }
  },
);

it("rolls back an interrupted Undo without exposing restored files or a partially advanced recovery receipt", async () => {
  const f = await pageDeletionFixture();
  const tx = await import("../src/main/libraryStore/libraryTransaction");
  const { recoverLibraryTransactions } =
    await import("../src/main/libraryStore/libraryTransactionRecovery");
  let release: (() => void) | undefined;
  try {
    const saved = await f.applyPage(await f.commandPage());
    const before = await f.capturePage(),
      record = await f.storage.record(saved.id);
    let injected = false;
    release = tx.setLibraryTransactionCrashInjectorForTests((point) => {
      if (!injected && point === "after-replace-step") {
        injected = true;
        throw new tx.SimulatedLibraryTransactionCrash(point);
      }
    });
    await expect(f.recoverPage(saved.id, "undo")).rejects.toBeInstanceOf(
      tx.SimulatedLibraryTransactionCrash,
    );
    release();
    release = undefined;
    expect(injected).toBe(true);
    await recoverLibraryTransactions();
    await f.restart();
    expect(await f.capturePage()).toEqual(before);
    expect(await f.storage.record(saved.id)).toEqual(record);
    await f.recoverPage(saved.id, "undo");
    await f.assertPageOriginal();
  } finally {
    release?.();
    await f.close();
  }
});
