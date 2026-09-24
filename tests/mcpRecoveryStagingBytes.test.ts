import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";

let fixture: Awaited<ReturnType<typeof libraryImportFixture>>;
beforeAll(async () => {
  fixture = await libraryImportFixture();
});
afterAll(async () => {
  await fixture?.close();
});

it("restores exactly 256 MiB of content while retaining the unchanged source byte and per-file limits", async () => {
  const f = fixture;
  const { captureChapterDeletionTree, captureStagedDeletionTree } =
    await import("../src/main/mcp/mcpChapterDeletionFiles");
  const { runLibraryTransaction } =
    await import("../src/main/libraryStore/libraryTransaction");
  const { withLibraryMutation } = await import("../src/main/library/lock");
  const destination = join(f.env.libraryDir, "exact-byte-capacity");
  const expected = await withLibraryMutation(() =>
    runLibraryTransaction("exact-recovery-bytes", async (tx) => {
      const staged = await tx.createPublishedDirectory(destination);
      await writeFile(join(staged.stagingDirectory, "work.json"), "{}");
      await zeroFile(
        join(staged.stagingDirectory, "first.bin"),
        128 * 1024 * 1024,
      );
      await zeroFile(
        join(staged.stagingDirectory, "second.bin"),
        128 * 1024 * 1024 - 2,
      );
      const tree = await captureStagedDeletionTree(
        staged,
        () => {},
        "work.json",
      );
      expect(tree.files.reduce((sum, file) => sum + file.bytes, 0)).toBe(
        256 * 1024 * 1024,
      );
      tx.beforePublish(async () => {
        expect(
          await captureStagedDeletionTree(staged, () => {}, "work.json"),
        ).toEqual(tree);
      });
      return tree;
    }),
  );
  expect(
    await captureChapterDeletionTree(destination, () => {}, "work.json"),
  ).toEqual(expected);
  await writeFile(join(destination, "one-byte-too-many.bin"), "x");
  await expect(
    captureChapterDeletionTree(destination, () => {}, "work.json"),
  ).rejects.toThrow(/256 MiB/);
});

async function zeroFile(path: string, bytes: number) {
  const handle = await open(path, "wx");
  try {
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
}
