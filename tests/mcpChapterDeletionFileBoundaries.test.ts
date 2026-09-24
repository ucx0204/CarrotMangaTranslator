import { open, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { chapterDeletionFilesFixture } from "./mcpChapterDeletionFiles.fixture";

it("rejects traversal, ambiguous names, missing parents and oversized inventories", async () => {
  const f = await chapterDeletionFilesFixture();
  const { validateChapterDeletionTree } =
    await import("../src/main/mcp/mcpChapterDeletionFiles");
  try {
    for (const path of [
      "../outside",
      "/absolute",
      "C:/outside",
      "a\\b",
      "a:stream",
      "nul",
      "trailing.",
      "trailing ",
      "unlisted/file.bin",
      "a/../b",
      "a//b",
      Array(34).fill("deep").join("/"),
    ]) {
      const tree = structuredClone(f.tree);
      tree.files.push({ ...tree.files[0], path });
      expect(() => validateChapterDeletionTree(tree), path).toThrow();
    }
    const duplicate = structuredClone(f.tree);
    duplicate.files.push({
      ...duplicate.files[0],
      path: duplicate.files[0].path.toUpperCase(),
    });
    expect(() => validateChapterDeletionTree(duplicate)).toThrow("overlap");
    const noMetadata = {
      ...f.tree,
      files: f.tree.files.filter((file) => file.path !== "chapter.json"),
    };
    expect(() => validateChapterDeletionTree(noMetadata)).toThrow(
      "metadata is missing",
    );
    const tooMany = {
      directories: [],
      files: Array.from({ length: 2001 }, (_, index) => ({
        ...f.tree.files[0],
        path: `file-${index}`,
      })),
    };
    expect(() => validateChapterDeletionTree(tooMany)).toThrow();
    const tooLarge = {
      directories: [],
      files: ["chapter.json", "first.bin", "second.bin"].map((path) => ({
        path,
        bytes: 128 * 1024 * 1024,
        sha256: "a".repeat(64),
      })),
    };
    expect(() => validateChapterDeletionTree(tooLarge)).toThrow("budget");
  } finally {
    await f.close();
  }
});

it("refuses a file symlink without following it and preserves the external input", async () => {
  const f = await chapterDeletionFilesFixture();
  const link = join(f.directory, "linked.png");
  try {
    const original = await readFile(f.originals[0]);
    await symlink(f.originals[0], link, "file");
    await expect(
      f.files.captureChapterDeletionTree(f.directory, () => {}),
    ).rejects.toThrow("links");
    expect(await readFile(f.originals[0])).toEqual(original);
  } finally {
    await unlink(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await f.close();
  }
});

it("rejects a sparse source over the per-file limit before loading its bytes", async () => {
  const f = await chapterDeletionFilesFixture();
  try {
    const handle = await open(join(f.directory, "oversized.bin"), "wx");
    try {
      await handle.truncate(128 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    await expect(
      f.files.captureChapterDeletionTree(f.directory, () => {}),
    ).rejects.toThrow("128 MiB");
    expect((await f.library.listLibrary()).works[0].chapterOrder).toEqual(
      f.source.work.chapterOrder,
    );
  } finally {
    await f.close();
  }
});

it("detects content changes after review and aborts native deletion rather than retaining different bytes", async () => {
  const f = await chapterDeletionFilesFixture();
  try {
    await writeFile(
      join(f.directory, "runs", "preserved", "note.txt"),
      "Later source that must remain",
    );
    await expect(f.retain(true)).rejects.toThrow(/changed|grew/u);
    expect(
      await readFile(
        join(f.directory, "runs", "preserved", "note.txt"),
        "utf8",
      ),
    ).toBe("Later source that must remain");
    expect((await f.library.listLibrary()).works[0].chapterOrder).toEqual(
      f.source.work.chapterOrder,
    );
  } finally {
    await f.close();
  }
});

it("rejects authenticated but wrong chunk bytes, truncated part lists and oversized ciphertext", async () => {
  const f = await chapterDeletionFilesFixture();
  try {
    const { record } = await f.retain();
    const hash = record.parts.flat()[0];
    const path = await f.storage.path(record.id, hash);
    const original = await readFile(path);
    await writeFile(
      path,
      JSON.stringify(
        await f.codec.seal({ chunk: Buffer.from("wrong").toString("base64") }),
      ),
    );
    await expect(
      f.files.verifyChapterDeletionFiles(f.storage, record, () => {}),
    ).rejects.toThrow("inconsistent");
    await writeFile(path, original);
    const truncated = structuredClone(record);
    truncated.parts.find((parts) => parts.length)?.pop();
    await expect(
      f.files.verifyChapterDeletionFiles(f.storage, truncated, () => {}),
    ).rejects.toThrow("do not match");
    const handle = await open(path, "r+");
    try {
      await handle.truncate(3 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    await expect(
      f.files.verifyChapterDeletionFiles(f.storage, record, () => {}),
    ).rejects.toThrow("Invalid encrypted");
  } finally {
    await f.close();
  }
});

it("honors cancellation between encrypted chunks and keeps the source in place", async () => {
  const f = await chapterDeletionFilesFixture();
  let cancelled = false;
  const seal = f.codec.seal.bind(f.codec);
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    const result = await seal(value);
    cancelled = true;
    return result;
  });
  try {
    const destination = join(f.env.libraryDir, "cancelled-backup");
    await expect(
      f.transaction(async (tx) => {
        const staged = await tx.createPublishedDirectory(destination);
        await f.files.retainChapterDeletionFiles(
          f.storage,
          f.directory,
          staged.stagingDirectory,
          f.tree,
          () => {
            if (cancelled) throw new Error("Cancelled during capture");
          },
        );
        await f.native.stageChapterDeletionUnlocked(
          tx,
          f.source.after,
          "chapter",
        );
      }),
    ).rejects.toThrow("Cancelled during capture");
    expect(
      await f.files.captureChapterDeletionTree(f.directory, () => {}),
    ).toEqual(f.tree);
  } finally {
    hook.mockRestore();
    await f.close();
  }
});
