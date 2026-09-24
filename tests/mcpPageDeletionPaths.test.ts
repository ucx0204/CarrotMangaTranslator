import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pageDeletionFixture } from "./mcpPageDeletion.fixture";

it("refuses a page artifact directory whose own user file would collide with the native recovery marker", async () => {
  const f = await pageDeletionFixture();
  try {
    const path = join(f.removedRun, ".mgt-transaction-owner.json");
    await writeFile(path, "Private original file, not transaction metadata");
    const before = await f.capturePage();
    await expect(f.previewPage()).rejects.toThrow(/reserved/);
    expect(await f.capturePage()).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(
      "Private original file, not transaction metadata",
    );
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});

it.runIf(process.platform === "win32")(
  "binds case-aliased Windows source paths to the actual captured filename for exact recovery",
  async () => {
    const f = await pageDeletionFixture();
    try {
      const current = JSON.parse(await readFile(f.chapterPath, "utf8"));
      current.pages[0].imagePath = current.pages[0].imagePath.toUpperCase();
      await writeFile(f.chapterPath, JSON.stringify(current));
      const before = await f.capturePage();
      const saved = await f.applyPage(await f.commandPage());
      expect((await f.inspectPage(saved.id)).canUndo).toBe(true);
      await f.restart();
      await f.recoverPage(saved.id, "undo");
      expect(await f.capturePage()).toEqual(before);
    } finally {
      await f.close();
    }
  },
);
