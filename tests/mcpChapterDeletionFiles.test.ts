import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { chapterDeletionFilesFixture } from "./mcpChapterDeletionFiles.fixture";

it("retains encrypted chunks, deletes through native staging and restores all original bytes and empty directories", async () => {
  const f = await chapterDeletionFilesFixture();
  try {
    const external = await Promise.all(
      f.originals.map((path) => readFile(path)),
    );
    const { record, storageBytes } = await f.retain(true);
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.library.listLibrary()).works[0].chapterOrder).toEqual([]);
    expect(storageBytes).toBeGreaterThan(0);
    const assets = await readdir(f.backup);
    expect(assets.length).toBeLessThan(record.parts.flat().length);
    for (const asset of assets) {
      expect(asset).toMatch(/^[a-f0-9]{64}\.bin$/u);
      expect(await readFile(join(f.backup, asset), "utf8")).not.toMatch(
        /Private original|manual scene|imagePath|sourceText/u,
      );
    }
    await f.restart();
    const roundtrip = JSON.parse(JSON.stringify(record));
    await f.files.verifyChapterDeletionFiles(f.storage, roundtrip, () => {});
    await f.restore(roundtrip);
    for (const [path, bytes] of f.original)
      expect(
        (await readFile(join(f.directory, path))).equals(bytes),
        path,
      ).toBe(true);
    expect(
      (await lstat(join(f.directory, "empty", "nested"))).isDirectory(),
    ).toBe(true);
    expect(
      await f.files.captureChapterDeletionTree(f.directory, () => {}),
    ).toEqual(f.tree);
    const remainingOriginals = await Promise.all(
      f.originals.map((path) => readFile(path)),
    );
    expect(remainingOriginals).toHaveLength(external.length);
    for (const [index, bytes] of remainingOriginals.entries())
      expect(bytes.equals(external[index]), f.originals[index]).toBe(true);
    expect((await f.library.listLibrary()).works[0].chapterOrder).toEqual(
      f.source.work.chapterOrder,
    );
  } finally {
    await f.close();
  }
});

it("does not remove a source when OS/profile encryption fails during capture", async () => {
  const f = await chapterDeletionFilesFixture();
  const seal = vi
    .spyOn(f.codec, "seal")
    .mockRejectedValue(new Error("Encryption unavailable"));
  try {
    await expect(f.retain(true)).rejects.toThrow("Encryption unavailable");
    seal.mockRestore();
    expect(
      await f.files.captureChapterDeletionTree(f.directory, () => {}),
    ).toEqual(f.tree);
    await expect(lstat(f.backup)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.library.listLibrary()).works[0].chapterOrder).toEqual(
      f.source.work.chapterOrder,
    );
  } finally {
    seal.mockRestore();
    await f.close();
  }
});

it("refuses corrupted encrypted bytes before recovery and leaves the deleted location absent", async () => {
  const f = await chapterDeletionFilesFixture();
  try {
    const { record } = await f.retain(true);
    const path = await f.storage.path(record.id, record.parts.flat()[0]);
    await writeFile(
      path,
      JSON.stringify({ encrypted: "not-the-original-envelope" }),
    );
    await expect(
      f.files.verifyChapterDeletionFiles(f.storage, record, () => {}),
    ).rejects.toThrow();
    await expect(f.restore(record)).rejects.toThrow();
    await expect(lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.library.listLibrary()).works[0].chapterOrder).toEqual([]);
  } finally {
    await f.close();
  }
});

it("does not overwrite a recreated directory and does not hide cancellation or changed inputs", async () => {
  const f = await chapterDeletionFilesFixture();
  try {
    const { record } = await f.retain();
    await expect(f.restore(record)).rejects.toThrow();
    await expect(
      f.files.verifyChapterDeletionFiles(f.storage, record, () => {
        throw new Error("Cancelled");
      }),
    ).rejects.toThrow("Cancelled");
    await expect(
      f.files.captureChapterDeletionTree(f.directory, () => {
        throw new Error("Revoked");
      }),
    ).rejects.toThrow("Revoked");
    for (const [path, bytes] of f.original)
      expect(
        (await readFile(join(f.directory, path))).equals(bytes),
        path,
      ).toBe(true);
  } finally {
    await f.close();
  }
});
