import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { retentionFixture } from "./mcpRetention.fixture";
import { capturePageRecovery } from "../src/shared/pageRecoverySnapshot";

it("records actual native text commits and recovers after session reconstruction without exposing snapshots", async () => {
  const f = await retentionFixture();
  try {
    expect((await f.list()).total).toBe(0);
    const before = capturePageRecovery((await f.snapshot()).pages[0]);
    await f.edit("durable text");
    const items = await f.list();
    expect(items.total).toBe(1);
    expect(JSON.stringify(items)).not.toMatch(/dataUrl|imagePath|durable text/);
    const id = items.items[0].id;
    const bytes = await readFile(await f.storage.path(id), "utf8");
    expect(bytes).not.toContain("durable text");
    await f.restart();
    expect((await f.inspect(id)).canUndo).toBe(true);
    const action = await f.actionInput(id);
    expect((await f.recover(id, "undo", action)).status).toBe("saved");
    expect(capturePageRecovery((await f.snapshot()).pages[0])).toEqual(before);
    await f.restart();
    expect((await f.recover(id, "undo", action)).historical).toBe(true);
    expect((await f.inspect(id)).canRedo).toBe(true);
    await f.recover(id, "redo");
    expect((await f.snapshot()).pages[0].blocks[0].translatedText).toBe(
      "durable text",
    );
    expect((await f.list()).total).toBe(1);
    await expect(
      f.invoke("carrot_get_change", { id }, f.auth("other-owner")),
    ).rejects.toThrow();
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("retains real native image bytes across history release and keeps restored images after explicit discard", async () => {
  const f = await retentionFixture();
  try {
    const before = (await f.snapshot()).pages[0];
    const original = await readFile(before.imagePath);
    expect((await f.paint()).status).toBe("completed");
    const changed = (await f.snapshot()).pages[0];
    const image = await readFile(requireImagePath(changed.inpaintedImagePath));
    const id = (await f.list()).items[0].id;
    await f.restart();
    await f.recover(id, "undo");
    expect((await f.snapshot()).pages[0].inpaintedImagePath).toBe(
      before.inpaintedImagePath,
    );
    await f.restart();
    await f.recover(id, "redo");
    const restored = (await f.snapshot()).pages[0];
    expect(
      await readFile(requireImagePath(restored.inpaintedImagePath)),
    ).toEqual(image);
    await f.invoke("carrot_discard_retained", { id, confirm: true });
    expect((await f.list()).total).toBe(0);
    expect(
      await readFile(requireImagePath(restored.inpaintedImagePath)),
    ).toEqual(image);
    expect(await readFile(before.imagePath)).toEqual(original);
    await expect(f.inspect(id)).rejects.toThrow();
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("rejects later edits and same-size source mutations without overwriting saved page state", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("first change");
    const id = (await f.list()).items[0].id;
    const old = await f.actionInput(id);
    await f.edit("later change");
    const saved = await readFile(f.chapterPath);
    await expect(f.recover(id, "undo", old)).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(saved);
    const other = (await f.list()).items[0].id;
    const action = await f.actionInput(other);
    const page = (await f.snapshot()).pages[0];
    const source = await readFile(page.imagePath);
    const corrupted = Buffer.from(source);
    corrupted[corrupted.length - 1] ^= 1;
    await writeFile(page.imagePath, corrupted);
    await expect(f.recover(other, "undo", action)).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(saved);
    await writeFile(page.imagePath, source);
  } finally {
    await f.close();
  }
});
it("fails closed on corrupt durable metadata and preserves all existing page bytes", async () => {
  const f = await retentionFixture();
  try {
    await f.edit("before corruption");
    const index = await f.storage.path();
    const saved = await readFile(f.chapterPath);
    await writeFile(index, "not encrypted metadata");
    await expect(f.edit("must not save")).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(saved);
    await expect(f.restart()).rejects.toThrow();
    const names = await readdir(join(f.env.libraryDir, ".mcp-retained"));
    expect(names.filter((name) => name !== "index.json")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

function requireImagePath(path: string | undefined): string {
  if (!path) throw new Error("Expected native restored image path.");
  return path;
}
