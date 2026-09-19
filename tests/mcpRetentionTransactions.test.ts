import { readFile, rm, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { capturePageRecovery } from "../src/shared/pageRecoverySnapshot";

for (const point of ["after-publish-step", "after-replace-step", "before-commit-point", "after-commit-point"] as const) {
  it(`keeps native page content and encrypted recovery together through ${point}`, async () => {
    const f = await retentionFixture();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const recovery = await import("../src/main/libraryStore/libraryTransactionRecovery");
    let restore = () => {};
    try {
      const before = capturePageRecovery((await f.snapshot()).pages[0]);
      restore = tx.setLibraryTransactionCrashInjectorForTests((position) => {
        if (position === point) throw new tx.SimulatedLibraryTransactionCrash(position);
      });
      await expect(f.edit("native crash checkpoint")).rejects.toThrow();
      restore();
      await recovery.recoverLibraryTransactions();
      await f.restart();
      const entries = await f.list();
      if (point === "after-commit-point") {
        expect(entries.total).toBe(1);
        expect((await f.snapshot()).pages[0].blocks[0].translatedText).toBe("native crash checkpoint");
        await f.recover(entries.items[0].id, "undo");
      } else {
        expect(entries.total).toBe(0);
      }
      expect(capturePageRecovery((await f.snapshot()).pages[0])).toEqual(before);
      for (const phase of ["active", "committed"]) {
        expect(await readdir(join(f.env.libraryDir, ".transactions", phase))).toEqual([]);
      }
    } finally {
      restore();
      await f.close();
    }
  });
}

it("preserves the durable action receipt after a committed undo loses its reply", async () => {
  const f = await retentionFixture();
  const tx = await import("../src/main/libraryStore/libraryTransaction");
  const recovery = await import("../src/main/libraryStore/libraryTransactionRecovery");
  let restore = () => {};
  try {
    const before = capturePageRecovery((await f.snapshot()).pages[0]);
    await f.edit("reply may be lost");
    const id = (await f.list()).items[0].id;
    const action = await f.actionInput(id);
    restore = tx.setLibraryTransactionCrashInjectorForTests((point) => {
      if (point === "after-commit-point") throw new tx.SimulatedLibraryTransactionCrash(point);
    });
    expect((await f.recover(id, "undo", action)).status).toBe("saved");
    restore();
    await recovery.recoverLibraryTransactions();
    await f.restart();
    expect((await f.recover(id, "undo", action)).historical).toBe(true);
    expect(capturePageRecovery((await f.snapshot()).pages[0])).toEqual(before);
    await expect(f.recover(id, "redo", action)).rejects.toThrow("different action");
    expect((await f.list()).total).toBe(1);
  } finally {
    restore();
    await f.close();
  }
});

it("does not silently initialize an empty catalog when the encrypted index is lost", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("must remain recoverable");
    const path = await f.storage.path();
    const index = await readFile(path);
    const page = await readFile(f.chapterPath);
    await rm(path);
    await expect(f.list()).rejects.toThrow();
    await expect(f.edit("must not replace missing history")).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(page);
    await writeFile(path, index);
    expect((await f.list()).total).toBe(1);
  } finally {
    await f.close();
  }
});

it("requires every exact page/review revision and leaves state untouched on malformed recovery", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("strict recovery request");
    const id = (await f.list()).items[0].id;
    const request = await f.actionInput(id);
    const before = await readFile(f.chapterPath);
    for (const pages of [[], [...request.pages, ...request.pages], request.pages.map((page) => ({ ...page, reviewRevision: "page-v1:0000000000000000" }))]) {
      await expect(f.invoke("carrot_undo_change", { ...request, pages })).rejects.toThrow();
    }
    await expect(f.invoke("carrot_undo_change", { ...request, snapshot: {} })).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(before);
    await f.recover(id, "undo");
  } finally {
    await f.close();
  }
});
